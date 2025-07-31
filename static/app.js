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
    const templatesTableBody = document.getElementById('templates-table-body');
    const templateFormTitle = document.getElementById('template-form-title');
    const templateIdInput = document.getElementById('template-id-input');
    const templateNameFormInput = document.getElementById('template-name-form-input');
    const templateBodyFormInput = document.getElementById('template-body-form-input');
    const saveTemplateButton = document.getElementById('save-template-button');
    const clearTemplateFormButton = document.getElementById('clear-template-form-button');

    // --- 2. DATA & STATE ---
    let customers = [];
    let currentConversationId = null;
    let ws = null;
    const campaigns = [
        { displayName: "Simple Text (No Vars)", templateName: "simple_text" },
        { displayName: "Promo (Image Header Only)", templateName: "promo_image" },
        { displayName: "Order Update (Body Vars Only)", templateName: "order_update" },
        { displayName: "Image Header + Body Vars", templateName: "image_body" },
        { displayName: "Tracking Link (Body + Button)", templateName: "tracking_link" },
        { displayName: "Full Template (Header + Body + Button)", templateName: "full_template" }
    ];

    // --- 3. FUNCTIONS ---
    function logToUI(message, status = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logLine = document.createElement('span');
        logLine.textContent = `\n[${timestamp}] ${message}`;
        logLine.className = `log-line log-${status}`;
        if(liveLog) {
            liveLog.appendChild(logLine);
            liveLog.scrollTop = liveLog.scrollHeight;
        }
    }

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
                    if (senderId === currentSelection) a.classList.add('active');
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

    function connectWebSocket() {
        if (ws && ws.readyState < 2) return;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/ws/log`;
        ws = new WebSocket(wsUrl);
        ws.onopen = () => logToUI('Connected to backend log...', 'success');
        ws.onmessage = (event) => {
            const logData = JSON.parse(event.data);
            logToUI(logData.message, logData.status);
        };
        ws.onclose = () => {
            ws = null;
            logToUI('Connection lost. Reconnecting...', 'warning');
            setTimeout(connectWebSocket, 5000);
        };
        ws.onerror = (error) => { console.error('WebSocket error:', error); ws.close(); };
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
    
    async function fetchAndDisplayTemplates() {
        try {
            const response = await fetch('/templates');
            const templates = await response.json();
            templatesTableBody.innerHTML = '';
            templates.forEach(template => {
                const row = templatesTableBody.insertRow();
                row.innerHTML = `<td>${template.template_name}</td><td>${template.template_body}</td><td><button class="btn btn-sm btn-outline-light edit-template-button" data-id="${template.id}" data-name="${template.template_name}" data-body="${template.template_body}">Edit</button> <button class="btn btn-sm btn-outline-danger delete-template-button" data-id="${template.id}">Delete</button></td>`;
            });
        } catch (error) {
            console.error("Failed to fetch templates:", error);
        }
    }
    
    function clearTemplateForm() {
        templateFormTitle.textContent = 'Add New Template';
        templateIdInput.value = '';
        templateNameFormInput.value = '';
        templateBodyFormInput.value = '';
    }

    // --- 4. EVENT LISTENERS ---
    loadCsvButton.addEventListener('click', () => csvFileInput.click());
    csvFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try { customers = parseCSV(e.target.result); displayCustomers(); logToUI(`✔ Loaded ${customers.length} customers.`, 'success'); }
            catch (error) { logToUI(`❌ Error: Could not parse CSV.`, 'error'); alert('Error: Could not parse the CSV file.'); }
        };
        reader.readAsText(file);
        event.target.value = '';
    });
    clearListButton.addEventListener('click', () => { customers = []; displayCustomers(); logToUI('ℹ️ Customer list cleared.', 'info'); });
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
        
        const campaignData = {
            campaign_type: campaignType,
            template_name: templateName,
            image_url: imageUrl || null,
            customers: customers
        };
        
        logToUI('--- Sending campaign request... ---', 'info');
        
        try {
            const response = await fetch('/start-campaign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(campaignData),
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.detail || 'An unknown error occurred.');
            }
            // This is the corrected success log
            logToUI(`✅ Backend accepted campaign. Watch for progress...`, 'success');
        } catch (error) {
            // This is the corrected error log
            logToUI(`❌ ERROR: Could not start campaign. ${error.message}`, 'error');
        }
    });

    sendReplyButton.addEventListener('click', async () => {
        const messageText = replyInput.value.trim();
        if (!messageText || !currentConversationId) return;
        sendReplyButton.disabled = true;
        try {
            const response = await fetch(`/conversations/${currentConversationId}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: messageText }) });
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
        presets[presetName] = { campaign: campaignSelect.value, template: templateNameInput.value, imageUrl: imageUrlInput.value };
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
    saveTemplateButton.addEventListener('click', async () => {
        const id = templateIdInput.value;
        const name = templateNameFormInput.value.trim();
        const body = templateBodyFormInput.value.trim();
        if (!name || !body) { alert('Template Name and Body cannot be empty.'); return; }
        const method = id ? 'PUT' : 'POST';
        const url = id ? `/templates/${id}` : '/templates';
        try {
            const response = await fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template_name: name, template_body: body }) });
            if (!response.ok) throw new Error('Failed to save template.');
            clearTemplateForm();
            fetchAndDisplayTemplates();
        } catch (error) {
            alert("Error saving template.");
        }
    });
    clearTemplateFormButton.addEventListener('click', clearTemplateForm);
    templatesTableBody.addEventListener('click', async (event) => {
        const target = event.target;
        const id = target.dataset.id;
        if (target.classList.contains('edit-template-button')) {
            templateFormTitle.textContent = 'Edit Template';
            templateIdInput.value = id;
            templateNameFormInput.value = target.dataset.name;
            templateBodyFormInput.value = target.dataset.body;
        }
        if (target.classList.contains('delete-template-button')) {
            if (confirm('Are you sure you want to delete this template?')) {
                try {
                    const response = await fetch(`/templates/${id}`, { method: 'DELETE' });
                    if (!response.ok) throw new Error('Failed to delete template.');
                    fetchAndDisplayTemplates();
                } catch (error) {
                    alert("Error deleting template.");
                }
            }
        }
    });

    // --- 5. INITIALIZATION ---
    populateCampaignDropdown();
    displayCustomers();
    connectWebSocket();
    fetchAndDisplayConversations();
    updatePresetDropdown();
    setInterval(fetchAndDisplayConversations, 30000);
    fetchAndDisplayTemplates();
});