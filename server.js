const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5501;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '25mb' })); // Allows large menu & gallery image payloads

// --- INITIALIZE SUPABASE CLIENT ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ CRITICAL: Missing SUPABASE_URL or SUPABASE_KEY in environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ Connected to Supabase client successfully!');

// --- API ROUTES ---

// 1. Get All Products
app.get('/api/products', async (req, res) => {
    try {
        const { data, error } = await supabase.from('products').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Add New Menu Item
app.post('/api/products', async (req, res) => {
    try {
        const { name, category, price, image, description } = req.body;
        const { data, error } = await supabase
            .from('products')
            .insert([{ name, category: category.trim(), price, image, description }])
            .select();

        if (error) throw error;
        res.json({ message: 'Product added successfully', data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Delete Menu Item
app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('products').delete().eq('id', id);
        if (error) throw error;
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Get All Orders
app.get('/api/orders', async (req, res) => {
    try {
        const { data, error } = await supabase.from('orders').select('*, order_items(*)').order('id', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Place New Order
app.post('/api/orders', async (req, res) => {
    try {
        const { customerName, customerPhone, address, total, items } = req.body;
        const orderCode = 'ORD-' + Math.floor(1000 + Math.random() * 9000);

        const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .insert([{
                order_code: orderCode,
                customer_name: customerName,
                customer_phone: customerPhone,
                delivery_address: address,
                total_amount: total,
                status: 'Preparing'
            }])
            .select()
            .single();

        if (orderError) throw orderError;

        const orderId = orderData.id;
        const formattedItems = items.map(item => ({
            order_id: orderId,
            item_name: item.name,
            quantity: item.quantity,
            price: item.price,
            addons: Array.isArray(item.addons) ? item.addons.join(', ') : (item.addons || '')
        }));

        const { error: itemsError } = await supabase.from('order_items').insert(formattedItems);
        if (itemsError) throw itemsError;

        res.json({ message: 'Order placed successfully', orderId: orderCode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Update Order Status
app.patch('/api/orders/:code', async (req, res) => {
    try {
        const { status } = req.body;
        const orderCode = req.params.code;

        const { error } = await supabase
            .from('orders')
            .update({ status })
            .eq('order_code', orderCode);

        if (error) throw error;
        res.json({ message: 'Order status updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Boss Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data: owner, error } = await supabase
            .from('owners')
            .select('*')
            .eq('email', email)
            .single();

        if (error || !owner) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }

        const passwordMatch = await bcrypt.compare(password, owner.password);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }

        res.json({ success: true, message: 'Login successful' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. Register Boss
app.post('/api/register-boss', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password required' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const { data, error } = await supabase
            .from('owners')
            .insert([{ email, password: hashedPassword }])
            .select();

        if (error) throw error;
        res.json({ success: true, message: 'New boss registered successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. Gallery API
app.get('/api/gallery', async (req, res) => {
    try {
        const { data, error } = await supabase.from('gallery').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gallery', async (req, res) => {
    try {
        const { images, caption } = req.body;
        const rowsToInsert = images.map(img => ({ image: img, caption }));
        const { data, error } = await supabase.from('gallery').insert(rowsToInsert).select();

        if (error) throw error;
        res.json({ message: 'Gallery photos uploaded successfully', data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/gallery/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('gallery').delete().eq('id', id);
        if (error) throw error;
        res.json({ message: 'Gallery photo deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 10. Store Settings & Menu Image API
app.get('/api/settings', async (req, res) => {
    try {
        const { data, error } = await supabase.from('store_settings').select('*').eq('id', 1).single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/settings', async (req, res) => {
    try {
        const { is_open, delivery_available } = req.body;
        const updates = {};
        if (is_open !== undefined) updates.is_open = is_open;
        if (delivery_available !== undefined) updates.delivery_available = delivery_available;

        const { data, error } = await supabase
            .from('store_settings')
            .update(updates)
            .eq('id', 1)
            .select()
            .single();

        if (error) throw error;
        res.json({ message: 'Store settings updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/store-menu-image', async (req, res) => {
    try {
        const { data, error } = await supabase.from('store_menu_image').select('*').eq('id', 1).single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/store-menu-image', async (req, res) => {
    try {
        const { image } = req.body;
        const { data, error } = await supabase
            .from('store_menu_image')
            .update({ image })
            .eq('id', 1)
            .select()
            .single();

        if (error) throw error;
        res.json({ message: 'Store menu image updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SERVE STATIC FRONTEND FILES ---
app.use(express.static(__dirname));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});