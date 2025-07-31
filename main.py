import os
import asyncio
import json
import time
import psycopg2
import requests
import re
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, BackgroundTasks, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ===================================================================
# --- 1. CONFIGURATION & MODELS ---
# ===================================================================
ACCESS_TOKEN = os.environ.get('ACCESS_TOKEN')
PHONE_NUMBER_ID = os.environ.get('PHONE_NUMBER_ID')
DATABASE_CONFIG = {
    "host": os.environ.get('DB_HOST'), "port": os.environ.get('DB_PORT'),
    "dbname": os.environ.get('DB_NAME'), "user": os.environ.get('DB_USER'),
    "password": os.environ.get('DB_PASSWORD')
}
VERIFY_TOKEN = os.environ.get('VERIFY_TOKEN', 'your-secret-webhook-token')

class Customer(BaseModel):
    phone: str
    name: str
    country_code: Optional[str] = ""
    order_status: Optional[str] = None
    tracking_id: Optional[str] = None
    product_name: Optional[str] = None
    offer_code: Optional[str] = None
    promo_link_id: Optional[str] = None

class CampaignRequest(BaseModel):
    template_name: str
    image_url: Optional[str] = None
    customers: List[Customer]

class Message(BaseModel):
    text: str
    timestamp: str
    direction: str

class Reply(BaseModel):
    message: str

class Template(BaseModel):
    id: int
    template_name: str
    template_body: str

class TemplateCreate(BaseModel):
    template_name: str
    template_body: str

# ===================================================================
# --- 2. WebSocket Log Manager ---
# ===================================================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: str, status: str = "info"):
        payload = {"message": message, "status": status}
        for connection in self.active_connections:
            await connection.send_text(json.dumps(payload))

log_manager = ConnectionManager()

# ===================================================================
# --- 3. HELPER FUNCTIONS (WhatsApp & DB) ---
# ===================================================================
def create_text_body(variables):
    if not variables: return None
    return {"type": "body", "parameters": [{"type": "text", "text": var} for var in variables]}

def create_image_header(image_url):
    return {"type": "header", "parameters": [{"type": "image", "image": {"link": image_url}}]}

def send_whatsapp_template(recipient_number, template_name, components=None):
    url = f"https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages"
    headers = {"Authorization": f"Bearer {ACCESS_TOKEN}", "Content-Type": "application/json"}
    template_data = {"name": template_name, "language": {"code": "en_US"}}
    if components:
        template_data["components"] = [c for c in components if c is not None]
    payload = {"messaging_product": "whatsapp", "to": recipient_number, "type": "template", "template": template_data}
    response = requests.post(url, headers=headers, data=json.dumps(payload))
    response.raise_for_status()
    return response.json()

def send_text_reply(recipient_number, message_text):
    url = f"https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages"
    headers = {"Authorization": f"Bearer {ACCESS_TOKEN}", "Content-Type": "application/json"}
    payload = { "messaging_product": "whatsapp", "to": recipient_number, "type": "text", "text": {"body": message_text} }
    response = requests.post(url, headers=headers, data=json.dumps(payload))
    response.raise_for_status()
    return response.json()

def fetch_conversations_from_db():
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT sender_id FROM messages ORDER BY sender_id;")
        conversations = cur.fetchall()
        return [convo[0] for convo in conversations]
    finally:
        if conn: conn.close()

def fetch_messages_for_sender_from_db(sender_id: str):
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("SELECT message_text, created_at, direction FROM messages WHERE sender_id = %s ORDER BY created_at ASC;", (sender_id,))
        messages = cur.fetchall()
        return [{"text": m[0], "timestamp": m[1].isoformat(), "direction": (m[2] or '').strip("'")} for m in messages]
    finally:
        if conn: conn.close()

def save_outgoing_message_to_db(sender_id, message_text):
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("INSERT INTO messages (sender_id, message_text, direction) VALUES (%s, %s, 'outgoing');", (sender_id, message_text))
        conn.commit()
    finally:
        if conn: conn.close()
        
def save_incoming_message_to_db(sender_id, message_text):
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("INSERT INTO messages (sender_id, message_text, direction) VALUES (%s, %s, 'incoming');", (sender_id, message_text))
        conn.commit()
    finally:
        if conn: conn.close()

def fetch_template_body_from_db(template_name: str):
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("SELECT template_body FROM templates WHERE template_name = %s;", (template_name,))
        result = cur.fetchone()
        return result[0] if result else None
    finally:
        if conn: conn.close()

def fetch_templates_from_db():
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("SELECT id, template_name, template_body FROM templates ORDER BY template_name;")
        templates = [{"id": r[0], "template_name": r[1], "template_body": r[2]} for r in cur.fetchall()]
        return templates
    finally:
        if conn: conn.close()

def add_template_to_db(template: TemplateCreate):
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("INSERT INTO templates (template_name, template_body) VALUES (%s, %s) RETURNING id;", (template.template_name, template.template_body))
        new_id = cur.fetchone()[0]
        conn.commit()
        return {"id": new_id, **template.model_dump()}
    finally:
        if conn: conn.close()

def update_template_in_db(template_id: int, template: TemplateCreate):
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("UPDATE templates SET template_name = %s, template_body = %s WHERE id = %s;", (template.template_name, template.template_body, template_id))
        conn.commit()
        return {"status": "success"}
    finally:
        if conn: conn.close()

def delete_template_from_db(template_id: int):
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("DELETE FROM templates WHERE id = %s;", (template_id,))
        conn.commit()
        return {"status": "success"}
    finally:
        if conn: conn.close()

# ===================================================================
# --- 4. Campaign Logic (Background Task) ---
# ===================================================================
async def run_campaign_logic(campaign_data: CampaignRequest):
    template_name = campaign_data.template_name
    await log_manager.broadcast(f"--- Starting Campaign '{template_name}' ---", "info")
    
    message_template = fetch_template_body_from_db(template_name)
    
    for customer_data in campaign_data.customers:
        customer_dict = customer_data.model_dump()
        recipient_number = f"{customer_dict.get('country_code', '')}{customer_dict.get('phone', '')}"
        customer_name = customer_dict.get('name', '')

        if not recipient_number or not customer_name:
            await log_manager.broadcast(f"⚠️ Skipping row due to missing name or phone.", "warning")
            continue
        try:
            components = []
            
            if campaign_data.image_url:
                components.append(create_image_header(campaign_data.image_url))
            
            if message_template:
                placeholders = [p.strip('{}') for p in re.findall(r'\{.*?\}', message_template)]
                body_vars = [customer_dict.get(p) for p in placeholders if customer_dict.get(p) is not None]
                if body_vars:
                    components.append(create_text_body(body_vars))
            
            send_whatsapp_template(recipient_number, template_name, components)
            
            message_to_save = f"(Sent Campaign: '{template_name}')"
            if message_template:
                try:
                    message_to_save = message_template.format(**customer_dict)
                except KeyError:
                    message_to_save = f"(Sent Campaign: '{template_name}') - render failed"
            
            save_outgoing_message_to_db(recipient_number, message_to_save)
            await log_manager.broadcast(f"✔ Sent '{template_name}' to {customer_name}", "success")
        except Exception as e:
            await log_manager.broadcast(f"❌ Failed to send to {customer_name}. Error: {e}", "error")
        await asyncio.sleep(1)
        
    await log_manager.broadcast("--- Campaign Finished ---", "info")

# ===================================================================
# --- 5. FastAPI App and API Endpoints ---
# ===================================================================
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.websocket("/ws/log")
async def websocket_endpoint(websocket: WebSocket):
    await log_manager.connect(websocket)
    try:
        while True: await websocket.receive_text()
    except Exception: log_manager.disconnect(websocket)

@app.post("/start-campaign")
async def start_campaign(campaign_data: CampaignRequest):
    asyncio.create_task(run_campaign_logic(campaign_data))
    return {"status": "Campaign has been started in the background."}

@app.get("/conversations")
def get_conversations():
    return {"conversations": fetch_conversations_from_db()}

@app.get("/conversations/{sender_id}", response_model=List[Message])
def get_conversation_history(sender_id: str):
    messages = fetch_messages_for_sender_from_db(sender_id)
    if isinstance(messages, dict): raise HTTPException(status_code=500, detail=messages.get("error"))
    return messages

@app.post("/conversations/{sender_id}/reply")
def post_reply(sender_id: str, reply: Reply, background_tasks: BackgroundTasks):
    try:
        send_text_reply(sender_id, reply.message)
        background_tasks.add_task(save_outgoing_message_to_db, sender_id, reply.message)
        return {"status": "Reply sent successfully"}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/whatsapp-webhook")
async def whatsapp_webhook(request: Request):
    data = await request.json()
    print("Webhook received:", json.dumps(data, indent=2))
    try:
        if data.get("object") == "whatsapp_business_account":
            for entry in data.get("entry", []):
                for change in entry.get("changes", []):
                    if change.get("field") == "messages":
                        message_data = change.get("value", {}).get("messages", [{}])[0]
                        if message_data.get("type") == "text":
                            sender_id = message_data.get("from")
                            message_text = message_data.get("text", {}).get("body")
                            if sender_id and message_text: save_incoming_message_to_db(sender_id, message_text)
    except Exception as e: print(f"Error processing webhook: {e}")
    return {"status": "ok"}

@app.get("/whatsapp-webhook")
async def whatsapp_verify(request: Request):
    if request.query_params.get("hub.mode") == "subscribe" and request.query_params.get("hub.challenge"):
        if request.query_params.get("hub.verify_token") == VERIFY_TOKEN:
            return int(request.query_params.get("hub.challenge"))
        return "Verification token mismatch", 403
    return "Hello webhook"

@app.get("/templates", response_model=List[Template])
def get_templates(): return fetch_templates_from_db()

@app.post("/templates", response_model=Template)
def create_template(template: TemplateCreate): return add_template_to_db(template)

@app.put("/templates/{template_id}")
def update_template(template_id: int, template: TemplateCreate): return update_template_in_db(template_id, template)

@app.delete("/templates/{template_id}")
def delete_template(template_id: int): return delete_template_from_db(template_id)

# ===================================================================
# --- 6. Serve the Frontend ---
# ===================================================================
app.mount("/", StaticFiles(directory="static", html=True), name="static")