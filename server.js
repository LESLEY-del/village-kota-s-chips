require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const compression = require('compression');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.static('public'));
const PORT = process.env.PORT || 5501;
const JWT_SECRET = process.env.JWT_SECRET;
const STORE_NAME = process.env.STORE_NAME || 'Village Kotas & Chips';

if (!JWT_SECRET) {
    console.error('❌ Missing JWT_SECRET in .env — add a long random string and restart.');
    process.exit(1);
}

// ================= MIDDLEWARE =================

app.set('trust proxy', 1);

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '15mb' }));

// ================= SUPABASE =================

const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY;

if (!process.env.SUPABASE_URL || !SUPABASE_KEY) {
    console.error(
        '❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) in .env.'
    );
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    SUPABASE_KEY
);

console.log('✅ Supabase client ready');

// ================= HELPERS =================

const httpError = (status, message) =>
    Object.assign(new Error(message), { status });

const asyncHandler = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch(err => {
        const status = err.status || 500;

        if (status === 500) {
            console.error('API Error:', err.message || err);
        }

        res.status(status).json({
            error: status === 500
                ? 'Something went wrong. Please try again.'
                : err.message
        });
    });
};

const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);

const money = (amount) =>
    'R ' + Number(amount).toFixed(2);

// ================= IMAGE UPLOAD =================
// Images are uploaded to Supabase Storage.
// The database stores image URLs, not large Base64 strings.

async function uploadToSupabaseStorage(base64Data, folder = 'uploads') {
    if (!base64Data) return base64Data;

    // Existing URLs do not need to be uploaded again.
    if (!base64Data.startsWith('data:')) {
        return base64Data;
    }

    const matches = base64Data.match(
        /^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/
    );

    if (!matches) {
        throw httpError(400, 'Invalid image data');
    }

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');

    const ext = (mimeType.split('/')[1] || 'jpg')
        .replace('jpeg', 'jpg')
        .replace(/[^a-z0-9]/gi, '') || 'jpg';

    const fileName =
        `${folder}/${Date.now()}-${Math.random()
            .toString(36)
            .substring(2, 8)}.${ext}`;

    const { error } = await supabase
        .storage
        .from('store-uploads')
        .upload(fileName, buffer, {
            contentType: mimeType,
            cacheControl: '31536000',
            upsert: false
        });

    if (error) {
        console.error('Storage upload error:', error.message);

        throw httpError(
            500,
            'Image upload failed. Check that the "store-uploads" bucket exists and is public.'
        );
    }

    const { data } = supabase
        .storage
        .from('store-uploads')
        .getPublicUrl(fileName);

    return data.publicUrl;
}

// ================= AUTHENTICATION =================

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';

    const token = header.startsWith('Bearer ')
        ? header.slice(7)
        : null;

    if (!token) {
        return res.status(401).json({
            error: 'Please sign in.'
        });
    }

    try {
        req.owner = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({
            error: 'Session expired. Please sign in again.'
        });
    }
}

// Basic login attempt limiter.
const loginAttempts = new Map();

function loginLimiter(req, res, next) {
    const now = Date.now();

    const recent = (loginAttempts.get(req.ip) || [])
        .filter(time => now - time < 15 * 60 * 1000);

    if (recent.length >= 10) {
        return res.status(429).json({
            success: false,
            error: 'Too many attempts. Try again in 15 minutes.'
        });
    }

    recent.push(now);
    loginAttempts.set(req.ip, recent);

    next();
}

// ================= EMAIL CONFIGURATION =================

const smtpPort = Number(process.env.SMTP_PORT || 465);

const mailer =
    (process.env.SMTP_USER && process.env.SMTP_PASS)
        ? nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: smtpPort,
            secure: smtpPort === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        })
        : null;

if (!mailer) {
    console.warn(
        '⚠️ SMTP_USER / SMTP_PASS not set — customer emails will NOT be sent.'
    );
}

function emailContent(kind, order) {
    const isDelivery = order.fulfillment_type === 'Delivery';

    const first = esc(
        (order.customer_name || '').trim().split(' ')[0] || 'there'
    );

    const code = order.order_code;

    if (kind === 'confirmed') {
        return {
            subject: `Booking confirmed – ${code}`,
            heading: 'Booking confirmed ✅',
            message: `Hi ${first}, thank you for your order! Your booking is confirmed and we will start preparing it shortly.`
        };
    }

    if (kind === 'preparing') {
        return {
            subject: `Your order is being prepared – ${code}`,
            heading: 'Your order is being prepared 🍳',
            message: `Hi ${first}, good news — our kitchen is preparing your order right now.`
        };
    }

    if (kind === 'ready' && isDelivery) {
        return {
            subject: `Your order is out for delivery – ${code}`,
            heading: 'Your order is out for delivery 🛵',
            message: `Hi ${first}, your order has been prepared and is on its way to you. Please keep your phone close.`
        };
    }

    return {
        subject: `Your order is ready – come collect – ${code}`,
        heading: 'Your order is ready 🎉',
        message: `Hi ${first}, your order has been prepared. Please come and collect it.`
    };
}

function sendOrderEmail(kind, order) {
    if (!mailer || !order || !order.customer_email) {
        return;
    }

    const content = emailContent(kind, order);

    const rows = (order.order_items || [])
        .map(item => `
            <tr>
                <td style="padding:6px 0;color:#444">
                    ${esc(item.quantity)}× ${esc(item.item_name)}
                </td>
                <td style="padding:6px 0;text-align:right;color:#444">
                    ${money(item.price * item.quantity)}
                </td>
            </tr>
        `)
        .join('');

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;border:1px solid #eee;border-radius:14px;overflow:hidden">
            <div style="background:#b45309;color:#fff;padding:18px 24px;font-size:18px;font-weight:bold">
                ${esc(STORE_NAME)}
            </div>

            <div style="padding:24px">
                <h2 style="margin:0 0 10px;color:#111">
                    ${content.heading}
                </h2>

                <p style="color:#333;line-height:1.5;margin:0 0 18px">
                    ${content.message}
                </p>

                <p style="margin:0 0 6px;color:#666;font-size:13px">
                    Order number:
                    <strong style="color:#111">${esc(order.order_code)}</strong>
                </p>

                <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;margin-top:10px">
                    ${rows}

                    <tr>
                        <td style="padding-top:10px;border-top:1px solid #eee;font-weight:bold">
                            Total
                        </td>

                        <td style="padding-top:10px;border-top:1px solid #eee;text-align:right;font-weight:bold">
                            ${money(order.total_amount)}
                        </td>
                    </tr>
                </table>

                <p style="color:#999;font-size:12px;margin-top:22px">
                    Thank you for choosing ${esc(STORE_NAME)}.
                </p>
            </div>
        </div>
    `;

    mailer.sendMail({
        from: process.env.MAIL_FROM ||
            `"${STORE_NAME}" <${process.env.SMTP_USER}>`,
        to: order.customer_email,
        subject: content.subject,
        html
    })
        .then(() => {
            console.log(
                `📧 "${kind}" email sent to ${order.customer_email}`
            );
        })
        .catch(err => {
            console.error('📧 Email failed:', err.message);
        });
}

// ================= PRODUCTS =================

// Public: customers can view products.
app.get('/api/products', asyncHandler(async (req, res) => {
    const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('id', { ascending: false });

    if (error) throw error;

    res.json(data);
}));

// Protected: add a product.
app.post('/api/products', requireAuth, asyncHandler(async (req, res) => {
    const { name, category, price, image, description } = req.body;

    if (!name || !category || !(Number(price) >= 0)) {
        throw httpError(
            400,
            'Name, category and a valid price are required'
        );
    }

    const imageUrl = await uploadToSupabaseStorage(
        image,
        'products'
    );

    const { data, error } = await supabase
        .from('products')
        .insert([{
            name: String(name).trim(),
            category: String(category).trim(),
            price: Number(price),
            image: imageUrl,
            description
        }])
        .select();

    if (error) throw error;

    res.json({
        message: 'Product added',
        data
    });
}));

// Protected: update a product.
app.patch('/api/products/:id', requireAuth, asyncHandler(async (req, res) => {
    const { price, image } = req.body;
    const updates = {};

    if (price !== undefined) {
        if (!(Number(price) >= 0)) {
            throw httpError(400, 'Invalid price');
        }

        updates.price = Number(price);
    }

    if (image) {
        updates.image = await uploadToSupabaseStorage(
            image,
            'products'
        );
    }

    if (!Object.keys(updates).length) {
        throw httpError(400, 'No changes provided');
    }

    const { data, error } = await supabase
        .from('products')
        .update(updates)
        .eq('id', req.params.id)
        .select();

    if (error) throw error;

    res.json({
        message: 'Product updated',
        data
    });
}));

// Protected: delete a product.
app.delete('/api/products/:id', requireAuth, asyncHandler(async (req, res) => {
    const { error } = await supabase
        .from('products')
        .delete()
        .eq('id', req.params.id);

    if (error) throw error;

    res.json({
        message: 'Product deleted'
    });
}));

// ================= ORDERS =================

// Protected: show active orders only.
app.get('/api/orders', requireAuth, asyncHandler(async (req, res) => {
    const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*)')
        .neq('status', 'Completed')
        .order('id', { ascending: false });

    if (error) throw error;

    res.json(data);
}));

// Public: customer places an order.
app.post('/api/orders', asyncHandler(async (req, res) => {
    const {
        customerName,
        customerPhone,
        customerEmail,
        fulfillment,
        address,
        items
    } = req.body;

    if (!customerName || !customerPhone) {
        throw httpError(400, 'Name and phone number are required');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail || '')) {
        throw httpError(400, 'A valid email address is required');
    }

    if (!['Delivery', 'In-Venue'].includes(fulfillment)) {
        throw httpError(400, 'Invalid fulfillment option');
    }

    if (!Array.isArray(items) || !items.length || items.length > 50) {
        throw httpError(400, 'Your basket is empty');
    }

    if (
        fulfillment === 'Delivery' &&
        !String(address || '').trim()
    ) {
        throw httpError(400, 'Delivery address is required');
    }

    const { data: settings, error: settingsError } = await supabase
        .from('store_settings')
        .select('*')
        .eq('id', 1)
        .single();

    if (settingsError) throw settingsError;

    if (settings && !settings.is_open) {
        throw httpError(403, 'Sorry, the store is currently closed.');
    }

    if (settings && fulfillment === 'Delivery' && !settings.delivery_available) {
        throw httpError(400, 'Delivery is currently unavailable.');
    }

    const ids = [...new Set(items.map(item => item.id))];

    const { data: products, error: prodErr } = await supabase
        .from('products')
        .select('id, name, price')
        .in('id', ids);

    if (prodErr) throw prodErr;

    const productMap = new Map(
        products.map(product => [String(product.id), product])
    );

    let total = 0;

    const lines = items.map(item => {
        const product = productMap.get(String(item.id));
        const quantity = parseInt(item.quantity, 10);

        if (
            !product ||
            !(quantity > 0) ||
            quantity > 50
        ) {
            throw httpError(
                400,
                'One of the items in your basket is no longer available.'
            );
        }

        total += Number(product.price) * quantity;

        return {
            item_name: product.name,
            quantity,
            price: Number(product.price)
        };
    });

    const orderCode = (
        'ORD-' +
        Date.now().toString(36).slice(-4) +
        Math.random().toString(36).slice(2, 4)
    ).toUpperCase();

    const deliveryAddress = fulfillment === 'In-Venue'
        ? 'In-Venue (Eat-In/Collection)'
        : String(address).trim();

    const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert([{
            order_code: orderCode,
            customer_name: String(customerName).trim(),
            customer_phone: String(customerPhone).trim(),
            customer_email: String(customerEmail).trim(),
            fulfillment_type: fulfillment,
            delivery_address: deliveryAddress,
            total_amount: total,
            status: 'New'
        }])
        .select()
        .single();

    if (orderError) throw orderError;

    const { error: itemsError } = await supabase
        .from('order_items')
        .insert(
            lines.map(line => ({
                order_id: order.id,
                ...line,
                addons: ''
            }))
        );

    if (itemsError) {
        await supabase
            .from('orders')
            .delete()
            .eq('id', order.id);

        throw itemsError;
    }

    // Respond before sending email to keep checkout responsive.
    res.json({
        message: 'Order placed',
        orderId: orderCode
    });

    sendOrderEmail('confirmed', {
        ...order,
        order_items: lines
    });
}));

// Protected: update order status.
app.patch('/api/orders/:code', requireAuth, asyncHandler(async (req, res) => {
    const statusAliases = {
        Prep: 'Preparing',
        Done: 'Completed',
        Ready: 'Ready',
        Preparing: 'Preparing',
        Completed: 'Completed'
    };

    const status = statusAliases[
        String(req.body.status || '').trim()
    ];

    if (!status) {
        throw httpError(
            400,
            'Invalid status. Use Preparing, Ready, or Completed.'
        );
    }

    const { data: current, error: findErr } = await supabase
        .from('orders')
        .select('status')
        .eq('order_code', req.params.code)
        .single();

    if (findErr || !current) {
        throw httpError(404, 'Order not found');
    }

    const { data: order, error } = await supabase
        .from('orders')
        .update({ status })
        .eq('order_code', req.params.code)
        .select('*, order_items(*)')
        .single();

    if (error) throw error;

    res.json({
        message: 'Status updated',
        status
    });

    if (current.status !== status) {
        if (status === 'Preparing') {
            sendOrderEmail('preparing', order);
        }

        if (status === 'Ready') {
            sendOrderEmail('ready', order);
        }
    }
}));

// ================= LOGIN & REGISTRATION =================

app.post('/api/login', loginLimiter, asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const { data: owner, error } = await supabase
        .from('owners')
        .select('*')
        .eq('email', String(email || '').trim())
        .maybeSingle();

    if (error) throw error;

    if (
        !owner ||
        !(await bcrypt.compare(
            String(password || ''),
            owner.password
        ))
    ) {
        return res.status(401).json({
            success: false,
            error: 'Invalid credentials'
        });
    }

    const token = jwt.sign(
        { email: owner.email },
        JWT_SECRET,
        { expiresIn: '12h' }
    );

    res.json({
        success: true,
        token
    });
}));

app.post('/api/register-boss', requireAuth, asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
        throw httpError(400, 'Enter a valid email');
    }

    if (!password || password.length < 8) {
        throw httpError(
            400,
            'Password must be at least 8 characters'
        );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const { error } = await supabase
        .from('owners')
        .insert([{
            email: email.trim(),
            password: hashedPassword
        }]);

    if (error) throw error;

    res.json({
        success: true
    });
}));

// ================= GALLERY =================

// Public: customers can view gallery photos.
app.get('/api/gallery', asyncHandler(async (req, res) => {
    const { data, error } = await supabase
        .from('gallery')
        .select('*')
        .order('id', { ascending: false });

    if (error) throw error;

    res.json(data);
}));

// Protected: upload gallery photos.
app.post('/api/gallery', requireAuth, asyncHandler(async (req, res) => {
    const { images, caption } = req.body;

    if (
        !Array.isArray(images) ||
        !images.length ||
        images.length > 20
    ) {
        throw httpError(400, 'Send between 1 and 20 images');
    }

    const urls = await Promise.all(
        images.map(image =>
            uploadToSupabaseStorage(image, 'gallery')
        )
    );

    const { error } = await supabase
        .from('gallery')
        .insert(
            urls.map(url => ({
                image: url,
                caption
            }))
        );

    if (error) throw error;

    res.json({
        message: 'Gallery uploaded'
    });
}));

app.delete('/api/gallery/:id', requireAuth, asyncHandler(async (req, res) => {
    const { error } = await supabase
        .from('gallery')
        .delete()
        .eq('id', req.params.id);

    if (error) throw error;

    res.json({
        message: 'Deleted'
    });
}));

// ================= SETTINGS =================

// Public: customers need to know store availability.
app.get('/api/settings', asyncHandler(async (req, res) => {
    const { data, error } = await supabase
        .from('store_settings')
        .select('*')
        .eq('id', 1)
        .single();

    if (error) throw error;

    res.json(data);
}));

// Protected: owner changes store availability.
app.patch('/api/settings', requireAuth, asyncHandler(async (req, res) => {
    const {
        is_open,
        delivery_available
    } = req.body;

    const updates = {};

    if (is_open !== undefined) {
        updates.is_open = Boolean(is_open);
    }

    if (delivery_available !== undefined) {
        updates.delivery_available = Boolean(delivery_available);
    }

    if (!Object.keys(updates).length) {
        throw httpError(400, 'No settings changes provided');
    }

    const { data, error } = await supabase
        .from('store_settings')
        .update(updates)
        .eq('id', 1)
        .select()
        .single();

    if (error) throw error;

    res.json({
        message: 'Settings updated',
        data
    });
}));

// ================= STORE MENU PAGES =================

// Public: customers can view store menu pages.
app.get('/api/store-menus', asyncHandler(async (req, res) => {
    const { data, error } = await supabase
        .from('store_menus')
        .select('*')
        .order('id', { ascending: true });

    if (error) throw error;

    res.json(data);
}));

// Protected: upload menu pages.
app.post('/api/store-menus', requireAuth, asyncHandler(async (req, res) => {
    const { images } = req.body;

    if (
        !Array.isArray(images) ||
        !images.length ||
        images.length > 20
    ) {
        throw httpError(400, 'Send between 1 and 20 images');
    }

    const urls = await Promise.all(
        images.map(image =>
            uploadToSupabaseStorage(image, 'menus')
        )
    );

    const { error } = await supabase
        .from('store_menus')
        .insert(
            urls.map(url => ({
                image: url
            }))
        );

    if (error) throw error;

    res.json({
        message: 'Store menu pictures uploaded successfully'
    });
}));

app.delete('/api/store-menus/:id', requireAuth, asyncHandler(async (req, res) => {
    const { error } = await supabase
        .from('store_menus')
        .delete()
        .eq('id', req.params.id);

    if (error) throw error;

    res.json({
        message: 'Menu page deleted'
    });
}));

// ================= STATIC FRONTEND =================
// Place index.html and owner.html inside the public folder.
// This prevents the server from exposing .env and server.js.

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',

    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// ================= START SERVER =================

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
