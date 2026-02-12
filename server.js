// server.js - Backend server for Common Deli live chat
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
const BOT_TOKEN = 'MTQ2NjYwMjE1ODQxMjc5NTkwNA.G5dMaZ.je1XK4bgI8gvMeV1XAqISDCa5SkNUaMv0Ov_gk';
const GUILD_ID = '854340642276900884';
const TICKETS_CATEGORY_ID = '1469496809255600151';

// Store active chat sessions
const activeSessions = new Map();

// WebSocket server for real-time chat
const wss = new WebSocket.Server({ noServer: true });

// Create Discord ticket and webhook
app.post('/api/create-order', async (req, res) => {
    try {
        const { customerName, discordUsername, groupLink, deliveryNotes, aptInstructions, tipAmount } = req.body;
        
        console.log('Creating ticket for:', customerName);
        
        // Create ticket channel
        const channelName = `ticket-${customerName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.substring(0, 100);
        
        const channelResponse = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: channelName,
                type: 0, // Text channel
                parent_id: TICKETS_CATEGORY_ID,
                topic: `Order ticket for ${customerName}`
            })
        });
        
        if (!channelResponse.ok) {
            throw new Error('Failed to create channel');
        }
        
        const channel = await channelResponse.json();
        const channelId = channel.id;
        
        console.log('Created channel:', channelId);
        
        // Create webhook in the ticket channel
        const webhookResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: 'Website Chat Bridge'
            })
        });
        
        if (!webhookResponse.ok) {
            throw new Error('Failed to create webhook');
        }
        
        const webhook = await webhookResponse.json();
        const webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
        
        console.log('Created webhook for channel');
        
        // Post order details to ticket
        const orderEmbed = {
            title: '🍔 New Order from Website',
            color: 0xdc2626,
            fields: [
                { name: '👤 Customer', value: customerName, inline: true },
                { name: '💬 Discord', value: discordUsername, inline: true },
                { name: '🔗 Group Link', value: groupLink, inline: false }
            ],
            timestamp: new Date().toISOString()
        };
        
        if (deliveryNotes) orderEmbed.fields.push({ name: '📝 Notes', value: deliveryNotes, inline: false });
        if (aptInstructions) orderEmbed.fields.push({ name: '🏠 Instructions', value: aptInstructions, inline: false });
        if (tipAmount) orderEmbed.fields.push({ name: '💵 Tip', value: `$${tipAmount}`, inline: true });
        
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '@everyone **New website order!**',
                embeds: [orderEmbed]
            })
        });
        
        // Store session
        const sessionId = Date.now().toString();
        activeSessions.set(sessionId, {
            channelId,
            webhookUrl,
            customerName,
            lastMessageId: null
        });
        
        res.json({
            success: true,
            sessionId,
            channelId
        });
        
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: error.message });
    }
});

// Send message from website to Discord
app.post('/api/send-message', async (req, res) => {
    try {
        const { sessionId, message } = req.body;
        const session = activeSessions.get(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        await fetch(session.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: message,
                username: session.customerName,
                avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png'
            })
        });
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Poll messages from Discord ticket
app.get('/api/get-messages/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = activeSessions.get(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        // Get messages from Discord channel
        let url = `https://discord.com/api/v10/channels/${session.channelId}/messages?limit=50`;
        if (session.lastMessageId) {
            url += `&after=${session.lastMessageId}`;
        }
        
        const messagesResponse = await fetch(url, {
            headers: {
                'Authorization': `Bot ${BOT_TOKEN}`
            }
        });
        
        if (!messagesResponse.ok) {
            throw new Error('Failed to fetch messages');
        }
        
        const messages = await messagesResponse.json();
        
        // Update last message ID
        if (messages.length > 0) {
            session.lastMessageId = messages[0].id;
        }
        
        // Filter and format messages
        const formattedMessages = messages
            .filter(m => !m.webhook_id || m.author.username !== session.customerName) // Exclude customer's own messages
            .reverse()
            .map(m => ({
                id: m.id,
                author: m.author.username,
                content: m.content,
                timestamp: m.timestamp,
                isBot: m.author.bot
            }));
        
        res.json({ messages: formattedMessages });
        
    } catch (error) {
        console.error('Error getting messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// Upgrade HTTP to WebSocket for real-time updates
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('⚠️  Remember to set BOT_TOKEN and TICKETS_CATEGORY_ID!');
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    
    ws.on('message', (message) => {
        console.log('Received:', message.toString());
    });
});
