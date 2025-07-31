import os
import asyncio
import json
import time
import psycopg2
import requests
from datetime import datetime
from typing import List, Optional, Dict

from fastapi import FastAPI, BackgroundTasks, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ===================================================================
# --- 1. CONFIGURATION & MODELS ---
# ===================================================================
ACCESS_TOKEN = os.environ.get('ACCESS_TOKEN', 'YOUR_FACEBOOK_ACCESS_TOKEN')
PHONE_NUMBER_ID = os.environ.get('PHONE_NUMBER_ID', '709687138895035')

DATABASE_CONFIG = {
    "host": os.environ.get('DB_HOST', "aws-0-ap-south-1.pooler.supabase.com"),
    "port": os.environ.get('DB_PORT', "6543"),
    "dbname": os.environ.get('DB_NAME', "postgres"),
    "user": os.environ.get('DB_USER', "postgres.hiteczxisxvecnuncmzp"),
    "password": os.environ.get('DB_PASSWORD', "YOUR_DATABASE_PASSWORD")
}

class Message(BaseModel): text: str; timestamp: str; direction: str
class Reply(BaseModel): message: str

# NEW: Pydantic model for a single template
class Template(BaseModel):
    id: int
    template_name: str
    template_body: str

# NEW: Pydantic model for creating/updating a template (ID is not required)
class TemplateCreate(BaseModel):
    template_name: str
    template_body: str

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
    campaign_type: str
    template_name: str
    image_url: Optional[str] = None
    customers: List[Customer]

class Message(BaseModel):
    text: str
    timestamp: str
    direction: str

class Reply(BaseModel):
    message: str

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

def create_dynamic_url_button(button_index, url_variable):
    return {"type": "button", "sub_type": "url", "index": str(button_index), "parameters": [{"type": "text", "text": url_variable}]}

def send_whatsapp_template(recipient_number, template_name, components=None, language_code="en_US"):
    url = f"https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages"
    headers = {"Authorization": f"Bearer {ACCESS_TOKEN}", "Content-Type": "application/json"}
    template_data = {"name": template_name, "language": {"code": language_code}}
    if components:
        template_data["components"] = [comp for comp in components if comp is not None]
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
        conn_string = f"host={DATABASE_CONFIG['host']} dbname={DATABASE_CONFIG['dbname']} user={DATABASE_CONFIG['user']} password={DATABASE_CONFIG['password']} port={DATABASE_CONFIG['port']} options='-c pool_mode=transaction' connect_timeout=10"
        conn = psycopg2.connect(conn_string)
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT sender_id FROM messages ORDER BY sender_id;")
        conversations = cur.fetchall()
        cur.close()
        return [convo[0] for convo in conversations]
    except Exception as e:
        print(f"Database Error: {e}")
        return {"error": str(e)}
    finally:
        if conn: conn.close()

def fetch_messages_for_sender_from_db(sender_id: str):
    conn = None
    try:
        conn_string = f"host={DATABASE_CONFIG['host']} dbname={DATABASE_CONFIG['dbname']} user={DATABASE_CONFIG['user']} password={DATABASE_CONFIG['password']} port={DATABASE_CONFIG['port']} options='-c pool_mode=transaction' connect_timeout=10"
        conn = psycopg2.connect(conn_string)
        cur = conn.cursor()
        cur.execute("SELECT message_text, created_at, direction FROM messages WHERE sender_id = %s ORDER BY created_at ASC;", (sender_id,))
        messages = cur.fetchall()
        cur.close()
        message_list = [{"text": msg[0], "timestamp": msg[1].isoformat(), "direction": (msg[2] or '').strip("'")} for msg in messages]
        return message_list
    except Exception as e:
        print(f"Database Error: {e}")
        return {"error": str(e)}
    finally:
        if conn: conn.close()

def save_outgoing_message_to_db(sender_id, message_text):
    conn = None
    try:
        conn_string = f"host={DATABASE_CONFIG['host']} dbname={DATABASE_CONFIG['dbname']} user={DATABASE_CONFIG['user']} password={DATABASE_CONFIG['password']} port={DATABASE_CONFIG['port']} options='-c pool_mode=transaction' connect_timeout=10"
        conn = psycopg2.connect(conn_string)
        cur = conn.cursor()
        sql_query = "INSERT INTO messages (sender_id, message_text, direction) VALUES (%s, %s, 'outgoing');"
        cur.execute(sql_query, (sender_id, message_text))
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"❌ DB Error (save outgoing): {e}")
    finally:
        if conn: conn.close()

def save_incoming_message_to_db(sender_id, message_text):
    conn = None
    try:
        conn_string = f"host={DATABASE_CONFIG['host']} dbname={DATABASE_CONFIG['dbname']} user={DATABASE_CONFIG['user']} password={DATABASE_CONFIG['password']} port={DATABASE_CONFIG['port']} options='-c pool_mode=transaction' connect_timeout=10"
        conn = psycopg2.connect(conn_string)
        cur = conn.cursor()
        sql_query = "INSERT INTO messages (sender_id, message_text, direction) VALUES (%s, %s, 'incoming');"
        cur.execute(sql_query, (sender_id, message_text))
        conn.commit()
        cur.close()
        print(f"✔ Saved incoming message from {sender_id} to database.")
    except Exception as e:
        print(f"❌ DB Error (save incoming): {e}")
    finally:
        if conn: conn.close()

def fetch_templates_from_db():
    conn = None
    try:
        conn = psycopg2.connect(**DATABASE_CONFIG)
        cur = conn.cursor()
        cur.execute("SELECT id, template_name, template_body FROM templates ORDER BY template_name;")
        templates = [{"id": row[0], "template_name": row[1], "template_body": row[2]} for row in cur.fetchall()]
        cur.close()
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
        cur.close()
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
        cur.close()
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
        cur.close()
        return {"status": "success"}
    finally:
        if conn: conn.close()        

# ===================================================================
# --- 4. Campaign Logic (Background Task) ---
# ===================================================================
async def run_campaign_logic(campaign_data: CampaignRequest):
    await log_manager.broadcast(f"--- Starting Campaign '{campaign_data.template_name}' ---", "info")
    campaign_type = campaign_data.campaign_type
    
    for customer in campaign_data.customers:
        recipient_number = f"{customer.country_code or ''}{customer.phone}"
        customer_name = customer.name
        if not recipient_number or not customer_name:
            await log_manager.broadcast(f"⚠️ Skipping row due to missing name or phone.", "warning")
            continue
        try:
            components = []
            if campaign_type == "promo_image":
                if not campaign_data.image_url: await log_manager.broadcast(f"⚠️ Skipping {customer_name}: Image URL required.", "warning"); continue
                components = [create_image_header(campaign_data.image_url)]
            elif campaign_type == "order_update":
                order_status = customer.order_status or 'processed'
                components = [create_text_body([customer_name, order_status])]
            elif campaign_type == "image_body":
                if not campaign_data.image_url: await log_manager.broadcast(f"⚠️ Skipping {customer_name}: Image URL required.", "warning"); continue
                components = [create_image_header(campaign_data.image_url), create_text_body([customer_name])]
            elif campaign_type == "tracking_link":
                tracking_id = customer.tracking_id or 'not-available'
                components = [create_text_body([customer_name]), create_dynamic_url_button(0, tracking_id)]
            elif campaign_type == "full_template":
                if not campaign_data.image_url: await log_manager.broadcast(f"⚠️ Skipping {customer_name}: Image URL required.", "warning"); continue
                product_name = customer.product_name or 'our latest product'
                offer_code = customer.offer_code or 'SALE25'
                promo_link_id = customer.promo_link_id or 'default-promo'
                components = [create_image_header(campaign_data.image_url), create_text_body([customer_name, product_name, offer_code]), create_dynamic_url_button(0, promo_link_id)]
            
            send_whatsapp_template(recipient_number, campaign_data.template_name, components)

            # NEW: Save a record of the sent message to our database for the inbox
            message_to_save = f"(Sent Campaign Template: '{campaign_data.template_name}')"
            save_outgoing_message_to_db(recipient_number, message_to_save)
            
            await log_manager.broadcast(f"✔ Sent '{campaign_data.template_name}' to {customer_name}", "success")
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
async def start_campaign(campaign_data: CampaignRequest): # Note the 'async' keyword
    # We now use asyncio.create_task to run the campaign in the background
    asyncio.create_task(run_campaign_logic(campaign_data))
    return {"status": "Campaign has been started in the background."}

@app.get("/conversations")
def get_conversations():
    return {"conversations": fetch_conversations_from_db()}

@app.get("/conversations/{sender_id}", response_model=List[Message])
def get_conversation_history(sender_id: str):
    messages = fetch_messages_for_sender_from_db(sender_id)
    if isinstance(messages, dict) and "error" in messages:
        raise HTTPException(status_code=500, detail=messages["error"])
    return messages

@app.post("/conversations/{sender_id}/reply")
def post_reply(sender_id: str, reply: Reply, background_tasks: BackgroundTasks):
    try:
        send_text_reply(sender_id, reply.message)
        background_tasks.add_task(save_outgoing_message_to_db, sender_id, reply.message)
        return {"status": "Reply sent successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    # --- NEW: Template Management Endpoints ---
@app.get("/templates", response_model=List[Template])
def get_templates():
    return fetch_templates_from_db()

@app.post("/templates", response_model=Template)
def create_template(template: TemplateCreate):
    return add_template_to_db(template)

@app.put("/templates/{template_id}")
def update_template(template_id: int, template: TemplateCreate):
    return update_template_in_db(template_id, template)

@app.delete("/templates/{template_id}")
def delete_template(template_id: int):
    return delete_template_from_db(template_id)

# ===================================================================
# --- 6. Serve the Frontend ---
# ===================================================================
# This mounts the 'static' folder to the root of the site and serves index.html
# IMPORTANT: This must be the LAST route added to the app.
app.mount("/", StaticFiles(directory="static", html=True), name="static")