const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5501;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- INITIALIZE SUPABASE CLIENT ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ Connected to Supabase client successfully!');

// --- HELPER: Upload Base64 or File to Supabase Storage Bucket ---
async function uploadToSupabaseStorage(base64Data, folder = 'uploads') {
    try {
        if (!base64Data || !base64Data.startsWith('data:')) return base64Data; // Return as-is if already a URL

        const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return base64Data;

        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const fileExt = mimeType.split('/')[1] || 'png';
        const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).substring(2, 7)}.${fileExt}`;

        const { data, error } = await supabase.storage
            .from('kotas-media')
            .upload(fileName, buffer, {
                contentType: mimeType,
                upsert: true
            });

        if (error) throw error;

        const { data: publicUrlData } = supabase.storage
            .from('kotas-media')
            .getPublicUrl(fileName);

        return publicUrlData.publicUrl;
    } catch (err) {
        console.error('Storage upload error:', err.message);
        return base64Data; 
    }
}

// --- HELPER WRAPPER TO ELIMINATE REPEATING TRY/CATCH ---
const asyncHandler = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch(err => {
        console.error('API Error:', err.message);
        res.status(500).json({ error: err.message });
    });
};

// --- API ROUTES ---

// Products
app.get('/api/products', asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('products').select('*').order('id', { ascending: false });
    if (error) throw error;
    res.json(data);
}));

app.post('/api/products', asyncHandler(async (req, res) => {
    const { name, category, price, image, description } = req.body;
    const imageUrl = await uploadToSupabaseStorage(image, 'products');

    const { data, error } = await supabase.from('products').insert([{ 
        name, category: category.trim(), price, image: imageUrl, description 
    }]).select();

    if (error) throw error;
    res.json({ message: 'Product added', data });
}));

app.patch('/api/products/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { price, image } = req.body;
    const updates = {};
    if (price !== undefined) updates.price = price;
    if (image !== undefined) {
        updates.image = await uploadToSupabaseStorage(image, 'products');
    }

    const { data, error } = await supabase.from('products').update(updates).eq('id', id).select();
    if (error) throw error;
    res.json({ message: 'Product updated', data });
}));

app.delete('/api/products/:id', asyncHandler(async (req, res) => {
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Product deleted' });
}));

// Orders
app.get('/api/orders', asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('orders').select('*, order_items(*)').order('id', { ascending: false });
    if (error) throw error;
    res.json(data);
}));

app.post('/api/orders', asyncHandler(async (req, res) => {
    const { customerName, customerPhone, address, total, items } = req.body;
    const orderCode = 'ORD-' + Math.floor(1000 + Math.random() * 9000);

    const { data: orderData, error: orderError } = await supabase.from('orders').insert([{
        order_code: orderCode, customer_name: customerName, customer_phone: customerPhone,
        delivery_address: address, total_amount: total, status: 'Preparing'
    }]).select().single();

    if (orderError) throw orderError;

    const formattedItems = items.map(item => ({
        order_id: orderData.id, item_name: item.name, quantity: item.quantity,
        price: item.price, addons: item.addons || ''
    }));

    const { error: itemsError } = await supabase.from('order_items').insert(formattedItems);
    if (itemsError) throw itemsError;

    res.json({ message: 'Order placed', orderId: orderCode });
}));

app.patch('/api/orders/:code', asyncHandler(async (req, res) => {
    const { status } = req.body;
    const { error } = await supabase.from('orders').update({ status }).eq('order_code', req.params.code);
    if (error) throw error;
    res.json({ message: 'Status updated' });
}));

// Login & Registration
app.post('/api/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const { data: owner, error } = await supabase.from('owners').select('*').eq('email', email).single();
    if (error || !owner || !(await bcrypt.compare(password, owner.password))) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    res.json({ success: true });
}));

app.post('/api/register-boss', asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('owners').insert([{ email, password: hashedPassword }]);
    if (error) throw error;
    res.json({ success: true });
}));

// Gallery
app.get('/api/gallery', asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('gallery').select('*').order('id', { ascending: false });
    if (error) throw error;
    res.json(data);
}));

app.post('/api/gallery', asyncHandler(async (req, res) => {
    const { images, caption } = req.body;
    const rows = [];
    for (const img of images) {
        const url = await uploadToSupabaseStorage(img, 'gallery');
        rows.push({ image: url, caption });
    }
    const { error } = await supabase.from('gallery').insert(rows);
    if (error) throw error;
    res.json({ message: 'Gallery uploaded' });
}));

app.delete('/api/gallery/:id', asyncHandler(async (req, res) => {
    const { error } = await supabase.from('gallery').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Deleted' });
}));

// Store Settings & Multi-Menu Images
app.get('/api/settings', asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('store_settings').select('*').eq('id', 1).single();
    if (error) throw error;
    res.json(data);
}));

app.patch('/api/settings', asyncHandler(async (req, res) => {
    const { is_open, delivery_available } = req.body;
    const updates = {};
    if (is_open !== undefined) updates.is_open = is_open;
    if (delivery_available !== undefined) updates.delivery_available = delivery_available;
    const { data, error } = await supabase.from('store_settings').update(updates).eq('id', 1).select().single();
    if (error) throw error;
    res.json({ message: 'Settings updated', data });
}));

app.get('/api/store-menus', asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('store_menus').select('*').order('id', { ascending: true });
    if (error) throw error;
    res.json(data);
}));

app.post('/api/store-menus', asyncHandler(async (req, res) => {
    const { images } = req.body;
    const rows = [];
    for (const img of images) {
        const url = await uploadToSupabaseStorage(img, 'menus');
        rows.push({ image: url });
    }
    const { error } = await supabase.from('store_menus').insert(rows);
    if (error) throw error;
    res.json({ message: 'Store menu pictures uploaded successfully' });
}));

app.delete('/api/store-menus/:id', asyncHandler(async (req, res) => {
    const { error } = await supabase.from('store_menus').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Menu page deleted' });
}));

// --- SERVE STATIC FRONTEND FILES ---
app.use(express.static(__dirname));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
