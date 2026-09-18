const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
// Límite de 50mb para permitir la subida de múltiples fotos en Base64 sin corte de conexión
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, 'views')));
app.use(express.static(path.join(__dirname))); 

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Configuración de Multer en memoria RAM
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const cpUpload = upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'additional_images', maxCount: 5 }
]);

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

// Obtener productos incluyendo el ID y la ruta de cada imagen de la galería
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

        const [products] = await pool.execute(query, params);

        for (let product of products) {
            // Traemos el ID y el path para que el admin pueda borrarlas de forma limpia por ID
            const [images] = await pool.execute('SELECT id, image_path FROM product_images WHERE product_id = ?', [product.id]);
            product.additional_images = images; 
        }

        res.json(products);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al obtener productos' });
    }
});

// Crear producto con imagen principal y galería opcional en Base64
app.post('/api/products', cpUpload, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { title, price, stock, brand_id, category_id } = req.body;
        
        let imagePath = '';
        if (req.files && req.files['image'] && req.files['image'][0]) {
            const file = req.files['image'][0];
            const b64 = Buffer.from(file.buffer).toString('base64');
            imagePath = `data:${file.mimetype};base64,${b64}`;
        }

        const productQuery = `
            INSERT INTO products (title, price, stock, image_path, brand_id, category_id, status) 
            VALUES (?, ?, ?, ?, ?, ?, 'disponible')
        `;
        
        const [result] = await connection.execute(productQuery, [
            title, 
            price, 
            stock || 1, 
            imagePath, 
            brand_id || null, 
            category_id || null
        ]);

        const productId = result.insertId;

        if (req.files && req.files['additional_images']) {
            for (const file of req.files['additional_images']) {
                const b64 = Buffer.from(file.buffer).toString('base64');
                const addImagePath = `data:${file.mimetype};base64,${b64}`;
                await connection.execute(
                    'INSERT INTO product_images (product_id, image_path) VALUES (?, ?)',
                    [productId, addImagePath]
                );
            }
        }

        await connection.commit();
        res.json({ success: true, message: 'Artículo y galería guardados permanentemente', id: productId });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, message: 'Error en el servidor al guardar el artículo' });
    } finally {
        connection.release();
    }
});

// Actualizar un artículo
app.put('/api/products/:id', cpUpload, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { id } = req.params;
        const { title, price, stock, brand_id, category_id } = req.body;

        let updateQuery = `
            UPDATE products 
            SET title = ?, price = ?, stock = ?, brand_id = ?, category_id = ?
        `;
        let queryParams = [title, price, stock, brand_id || null, category_id || null];

        if (req.files && req.files['image'] && req.files['image'][0]) {
            const file = req.files['image'][0];
            const b64 = Buffer.from(file.buffer).toString('base64');
            const newImagePath = `data:${file.mimetype};base64,${b64}`;
            updateQuery += `, image_path = ?`;
            queryParams.push(newImagePath);
        }

        updateQuery += ` WHERE id = ?`;
        queryParams.push(id);

        await connection.execute(updateQuery, queryParams);

        if (req.files && req.files['additional_images']) {
            for (const file of req.files['additional_images']) {
                const b64 = Buffer.from(file.buffer).toString('base64');
                const addImagePath = `data:${file.mimetype};base64,${b64}`;
                await connection.execute(
                    'INSERT INTO product_images (product_id, image_path) VALUES (?, ?)',
                    [id, addImagePath]
                );
            }
        }

        await connection.commit();
        res.json({ success: true, message: 'Artículo actualizado correctamente' });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al actualizar el artículo' });
    } finally {
        connection.release();
    }
});

// ELIMINAR una foto específica de la galería usando su ID único
app.delete('/api/product-images/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.execute('DELETE FROM product_images WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Imagen no encontrada' });
        }

        res.json({ success: true, message: 'Imagen de galería eliminada correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al eliminar la imagen de la galería' });
    }
});

// Eliminar un artículo del inventario por completo
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

// Vistas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});