document.addEventListener('DOMContentLoaded', () => {
    // --- 1. ELEMENT REFERENCES ---
    const campaignSelect = document.getElementById('campaign-select');
    const templateNameInput = document.getElementById('template-name-input');
    const imageUrlInput = document.getElementById('image-url-input');
    const manualNameInput = document.getElementById('manual-name-input');
    const manualCcInput = document.getElementById('manual-cc-input');
    const manualPhoneInput = document.getElementById('manual-phone-input');
    const manualAddButton = document.getElementById('manual-add-button');
    const loadCsvButton = document.getElementById('load-csv-button');
    const clearListButton = document.getElementById('clear-list-button');
    const startCampaignButton = document.getElementById('start-campaign-button');
    const customerTableBody = document.getElementById('customer-table-body');
    const csvFileInput = document.getElementById('csv-file-input');
    const liveLog = document.getElementById('live-log');
    const imagePreview = document.getElementById('image-preview');
    const imagePreviewPlaceholder = document.getElementById('image-preview-placeholder');
    const presetSelect = document.getElementById('preset-select');
    const savePresetButton = document.getElementById('save-preset-button');
    const deletePresetButton = document.getElementById('delete-preset-button');
    const conversationList = document.getElementById('conversation-list');
    const messageHistory = document.getElementById('message-history');
    const replyInput = document.getElementById('reply-input');
    const sendReplyButton = document.getElementById('send-reply-button');

    // --- 2. DATA & STATE ---
    let customers = [];
    let currentConversationId = null;
    const campaigns = [
        { displayName: "Simple Text (No Vars)", templateName: "simple_text" },
        { displayName: "Promo (Image Header Only)", templateName: "promo_image" },
        { displayName: "Order Update (Body Vars Only)", templateName: "order_update" },
        { displayName: "Image Header + Body Vars", templateName: "image_body" },
        { displayName: "Tracking Link (Body + Button)", templateName: "tracking_link" },
        { displayName: "Full Template (Header + Body + Button)", templateName: "full_template" }
    ];

    // --- 3. FUNCTIONS ---
    function populateCampaignDropdown() {
        campaignSelect.innerHTML = '<option selected>Select a Campaign Structure</option>';
        campaigns.forEach(campaign => {
            const option = document.createElement('option');
            option.value = campaign.templateName;
            option.textContent = campaign.displayName;
            campaignSelect.appendChild(option);
        });
    }

    function displayCustomers() {
        customerTableBody.innerHTML = '';
        if (customers.length === 0) {
            const row = customerTableBody.insertRow();
            const cell = row.insertCell();
            cell.colSpan = 2;
            cell.textContent = 'No customers loaded.';
            cell.style.textAlign = 'center';
            return;
        }
        customers.forEach(customer => {
            const row = customerTableBody.insertRow();
            const nameCell = row.insertCell();
            const phoneCell = row.insertCell();
            nameCell.textContent = customer.name || 'N/A';
            phoneCell.textContent = `${customer.country_code || ''}${customer.phone || ''}`;
        });
    }

    function parseCSV(text) {
        const lines = text.split('\n').filter(line => line.trim() !== '');
        if (lines.length < 2) throw new Error("CSV must have a header and at least one data row.");
        const headers = lines[0].split(',').map(header => header.trim());
        const data = [];
        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(value => value.trim());
            const entry = {};
            for (let j = 0; j < headers.length; j++) {
                entry[headers[j]] = values[j];
            }
            data.push(entry);
        }
        return data;
    }

    function displayMessageHistory(messages) {
        messageHistory.innerHTML = '';
        if (!messages || messages.length === 0) {
            messageHistory.innerHTML = '<p class="text-muted text-center">No messages in this conversation.</p>';
            return;
        }
        messages.forEach(msg => {
            const wrapper = document.createElement('div');
            const bubble = document.createElement('div');
            const timestamp = new Date(msg.timestamp).toLocaleString();
            wrapper.className = 'message-wrapper';
            bubble.className = 'message-bubble';
            if (msg.direction && msg.direction.trim() === 'incoming') {
                wrapper.classList.add('incoming');
                bubble.classList.add('bg-light', 'text-dark');
            } else {
                wrapper.classList.add('outgoing');
                bubble.classList.add('bg-danger', 'text-white');
            }
            bubble.innerHTML = `${msg.text}<br><small class="text-muted" style="font-size: 0.75em;">${timestamp}</small>`;
            wrapper.appendChild(bubble);
            messageHistory.appendChild(wrapper);
        });
        messageHistory.scrollTop = messageHistory.scrollHeight;
    }

    async function fetchAndDisplayConversations() {
        try {
            const response = await fetch('/conversations');
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            const data = await response.json();
            const currentSelection = document.querySelector('.conversation-list li a.active')?.dataset.senderId;
            conversationList.innerHTML = '';
            
            if (data.conversations && data.conversations.length > 0) {
                data.conversations.forEach(senderId => {
                    const li = document.createElement('li');
                    const a = document.createElement('a');
                    a.href = '#';
                    a.textContent = senderId;
                    a.dataset.senderId = senderId;
                    if (senderId === currentSelection) {
                        a.classList.add('active');
                    }
                    a.addEventListener('click', async (event) => {
                        event.preventDefault();
                        currentConversationId = senderId;
                        document.querySelectorAll('.conversation-list li a').forEach(el => el.classList.remove('active'));
                        a.classList.add('active');
                        messageHistory.innerHTML = '<p class="text-muted text-center">Loading messages...</p>';
                        try {
                            const historyResponse = await fetch(`/conversations/${senderId}`);
                            const messages = await historyResponse.json();
                            displayMessageHistory(messages);
                            replyInput.disabled = false;
                            sendReplyButton.disabled = false;
                        } catch (error) {
                            messageHistory.innerHTML = '<p class="text-danger text-center">Error loading messages.</p>';
                        }
                    });
                    li.appendChild(a);
                    conversationList.appendChild(li);
                });
            } else {
                conversationList.innerHTML = '<li><a href="#">No conversations found.</a></li>';
            }
        } catch (error) {
            console.error("Failed to fetch conversations:", error);
            conversationList.innerHTML = `<li><a href="#">Error loading conversations.</a></li>`;
        }
    }

    let ws = null

    function connectWebSocket() {

         if (ws && ws.readyState < 2) { 
            console.log("WebSocket already connecting or open.");
            return;
        }

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/ws/log`;

        console.log(`Attempting to connect WebSocket to: ${wsUrl}`);
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            liveLog.innerHTML = '<span class="log-info">Connected to backend log...</span>';
            const logData = JSON.parse(event.data);
            logToUI('Connected to backend log...', 'success');
        };
        ws.onmessage = (event) => {
            const logData = JSON.parse(event.data);
            logToUI(logData.message, logData.status);
            const logLine = document.createElement('span');
            logLine.textContent = `\n[${new Date().toLocaleTimeString()}] ${logData.message}`;
            logLine.className = `log-line log-${logData.status}`;
            liveLog.appendChild(logLine);
            liveLog.scrollTop = liveLog.scrollHeight;
        };
        ws.onclose = () => {
            const reconnectMsg = document.createElement('span');
            reconnectMsg.textContent = '\nConnection lost. Attempting to reconnect...';
            reconnectMsg.className = 'log-line log-warning';
            liveLog.appendChild(reconnectMsg);
            console.log('WebSocket connection closed. Reconnecting...');
            ws = null; // Clear the variable so the next attempt can proceed
            logToUI('Connection lost. Attempting to reconnect...', 'warning');
            setTimeout(connectWebSocket, 3000);
        };
        ws.onerror = (error) => { ws.close(); };
    }

    function savePresets(presets) { localStorage.setItem('campaignPresets', JSON.stringify(presets)); }
    function loadPresets() { const p = localStorage.getItem('campaignPresets'); return p ? JSON.parse(p) : {}; }
    function updatePresetDropdown() {
        const presets = loadPresets();
        presetSelect.innerHTML = '<option selected>Load a preset...</option>';
        for (const name in presets) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            presetSelect.appendChild(option);
        }
    }

    function logToUI(message, status = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logLine = document.createElement('span');
        logLine.textContent = `\n[${timestamp}] ${message}`;
        logLine.className = `log-line log-${status}`;
        liveLog.appendChild(logLine);
        // This is the auto-scroll logic
        liveLog.scrollTop = liveLog.scrollHeight;
    }


    // --- 4. EVENT LISTENERS ---
    loadCsvButton.addEventListener('click', () => csvFileInput.click());
    csvFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try { customers = parseCSV(e.target.result); displayCustomers();logToUI(`✔ Loaded ${customers.length} customers from CSV.`, 'success'); }
            catch (error) {logToUI(`❌ Error: Could not parse the CSV file.`, 'error'); alert('Error: Could not parse the CSV file.'); }
        };
        reader.readAsText(file);
        event.target.value = '';
    });
    clearListButton.addEventListener('click', () => { customers = []; displayCustomers();logToUI('ℹ️ Customer list cleared.', 'info'); });
    manualAddButton.addEventListener('click', () => {
        const name = manualNameInput.value.trim();
        const phone = manualPhoneInput.value.trim();
        const country_code = manualCcInput.value.trim();
        if (!name || !phone) { alert('Please enter at least a name and phone number.'); return; }
        customers.push({ name, phone, country_code });
        displayCustomers();
        logToUI(`✔ Manually added customer: ${name}.`, 'success');
        manualNameInput.value = ''; manualPhoneInput.value = ''; manualCcInput.value = '';
    });
    startCampaignButton.addEventListener('click', async () => {
        const campaignType = campaignSelect.value;
        const templateName = templateNameInput.value.trim();
        const imageUrl = imageUrlInput.value.trim();
        if (campaignType === 'Select a Campaign Structure') { alert('Please select a Campaign Structure.'); return; }
        if (!templateName) { alert('Please enter a Meta Template Name.'); return; }
        if (customers.length === 0) { alert('Please load or add customers.'); return; }
        const campaignData = { campaign_type: campaignType, template_name: templateName, image_url: imageUrl || null, customers: customers };
        logToUI(`--- Sending campaign request to backend... ---`, 'info');
        try {
            const response = await fetch('/start-campaign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(campaignData),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.detail || 'An unknown error occurred.');
            logToUI(`✅ Backend accepted campaign. Watch for progress...`, 'success');
        } catch (error) {
            const logLine = document.createElement('span');
            logLine.textContent = `\n[${new Date().toLocaleTimeString()}] ❌ ERROR: Could not start campaign. ${error.message}`;
            logLine.className = 'log-line log-error';
            liveLog.appendChild(logLine);
            logToUI(`❌ ERROR: Could not start campaign. ${error.message}`, 'error');
        }
    });
    sendReplyButton.addEventListener('click', async () => {
        const messageText = replyInput.value.trim();
        if (!messageText || !currentConversationId) return;
        sendReplyButton.disabled = true;
        try {
            const response = await fetch(`/conversations/${currentConversationId}/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: messageText })
            });
            if (!response.ok) throw new Error('Failed to send reply.');
            replyInput.value = '';
            const historyResponse = await fetch(`/conversations/${currentConversationId}`);
            const messages = await historyResponse.json();
            displayMessageHistory(messages);
        } catch (error) {
            alert('Failed to send reply.');
        } finally {
            sendReplyButton.disabled = false;
        }
    });
    imageUrlInput.addEventListener('blur', () => {
        const url = imageUrlInput.value.trim();
        if (url) {
            imagePreview.src = url;
            imagePreview.style.display = 'block';
            imagePreviewPlaceholder.style.display = 'none';
        } else {
            imagePreview.style.display = 'none';
            imagePreviewPlaceholder.style.display = 'block';
        }
    });
    savePresetButton.addEventListener('click', () => {
        const presetName = prompt("Enter a name for this preset:");
        if (!presetName) return;
        const presets = loadPresets();
        presets[presetName] = {
            campaign: campaignSelect.value,
            template: templateNameInput.value,
            imageUrl: imageUrlInput.value
        };
        savePresets(presets);
        updatePresetDropdown();
        alert(`Preset '${presetName}' saved!`);
    });
    presetSelect.addEventListener('change', () => {
        const presetName = presetSelect.value;
        const presets = loadPresets();
        if (presets[presetName]) {
            const preset = presets[presetName];
            campaignSelect.value = preset.campaign;
            templateNameInput.value = preset.template;
            imageUrlInput.value = preset.imageUrl;
            imageUrlInput.dispatchEvent(new Event('blur'));
        }
    });
    deletePresetButton.addEventListener('click', () => {
        const presetName = presetSelect.value;
        if (!presetName || presetName === 'Load a preset...') { alert("Please select a preset to delete."); return; }
        if (confirm(`Are you sure you want to delete the preset '${presetName}'?`)) {
            const presets = loadPresets();
            delete presets[presetName];
            savePresets(presets);
            updatePresetDropdown();
            alert(`Preset '${presetName}' deleted.`);
        }
    });

    // --- 5. INITIALIZATION ---
    populateCampaignDropdown();
    displayCustomers();
    connectWebSocket();
    fetchAndDisplayConversations();
    updatePresetDropdown();
    setInterval(fetchAndDisplayConversations, 25000);
});