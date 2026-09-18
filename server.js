const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir vistas estáticas y archivos de la raíz (como el logo.png)
app.use(express.static(path.join(__dirname, 'views')));
app.use(express.static(path.join(__dirname))); 

// Configuración de la conexión a MySQL (HostGator)
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Configuración de Multer en memoria RAM para procesar las imágenes en Base64
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==================== RUTAS PÚBLICAS Y DE CATÁLOGO ====================

app.get('/api/brands', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM brands ORDER BY name ASC');
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al obtener marcas' });
    }
});

app.get('/api/categories', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM categories ORDER BY name ASC');
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al obtener categorías' });
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const { search, brand, category } = req.query;
        let query = `
            SELECT p.*, b.name as brand_name, c.name as category_name 
            FROM products p
            LEFT JOIN brands b ON p.brand_id = b.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.stock > 0
        `;
        let params = [];

        if (search) {
            query += ` AND p.title LIKE ?`;
            params.push(`%${search}%`);
        }
        if (brand) {
            query += ` AND p.brand_id = ?`;
            params.push(brand);
        }
        if (category) {
            query += ` AND p.category_id = ?`;
            params.push(category);
        }

        query += ` ORDER BY p.created_at DESC`;

        const [rows] = await pool.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al obtener productos' });
    }
});

// Crear producto con imagen guardada permanentemente en Base64 en MySQL
app.post('/api/products', upload.single('image'), async (req, res) => {
    try {
        const { title, price, stock, brand_id, category_id } = req.body;
        
        let imagePath = '';
        if (req.file) {
            const b64 = Buffer.from(req.file.buffer).toString('base64');
            imagePath = `data:${req.file.mimetype};base64,${b64}`;
        }

        const query = `
            INSERT INTO products (title, price, stock, image_path, brand_id, category_id, status) 
            VALUES (?, ?, ?, ?, ?, ?, 'disponible')
        `;
        
        const [result] = await pool.execute(query, [
            title, 
            price, 
            stock || 1, 
            imagePath, 
            brand_id || null, 
            category_id || null
        ]);

        res.json({ success: true, message: 'Artículo guardado permanentemente', id: result.insertId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error en el servidor al guardar el artículo' });
    }
});


// ==================== RUTAS DE ADMINISTRACIÓN Y GESTIÓN ====================

app.put('/api/products/:id/stock', async (req, res) => {
    try {
        const { id } = req.params;
        const { stock, status } = req.body;

        const [result] = await pool.execute(
            'UPDATE products SET stock = ?, status = ? WHERE id = ?',
            [stock, status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado' });
        }

        res.json({ success: true, message: 'Inventario actualizado correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al actualizar inventario' });
    }
});

// Editar un artículo (actualiza datos y la imagen nueva en Base64 si se adjunta)
app.put('/api/products/:id', upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, price, stock, brand_id, category_id } = req.body;

        if (req.file) {
            const b64 = Buffer.from(req.file.buffer).toString('base64');
            const newImagePath = `data:${req.file.mimetype};base64,${b64}`;
            const query = `
                UPDATE products 
                SET title = ?, price = ?, stock = ?, brand_id = ?, category_id = ?, image_path = ? 
                WHERE id = ?
            `;
            await pool.execute(query, [title, price, stock, brand_id || null, category_id || null, newImagePath, id]);
        } else {
            const query = `
                UPDATE products 
                SET title = ?, price = ?, stock = ?, brand_id = ?, category_id = ? 
                WHERE id = ?
            `;
            await pool.execute(query, [title, price, stock, brand_id || null, category_id || null, id]);
        }

        res.json({ success: true, message: 'Artículo actualizado correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al actualizar el artículo' });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.execute('DELETE FROM products WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado' });
        }

        res.json({ success: true, message: 'Artículo eliminado correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al eliminar el artículo' });
    }
});

app.post('/api/brands', async (req, res) => {
    try {
        const { name } = req.body;
        const [result] = await pool.execute('INSERT INTO brands (name) VALUES (?)', [name]);
        res.json({ success: true, id: result.insertId, name });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al crear la marca' });
    }
});

app.post('/api/categories', async (req, res) => {
    try {
        const { name } = req.body;
        const [result] = await pool.execute('INSERT INTO categories (name) VALUES (?)', [name]);
        res.json({ success: true, id: result.insertId, name });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al crear la categoría' });
    }
});


// ==================== INICIO DEL SERVIDOR ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});