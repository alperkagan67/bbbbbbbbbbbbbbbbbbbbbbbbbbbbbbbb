import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..', '..');
const uploadDir = path.join(projectRoot, 'uploads', 'vehicles');

const corsOptions = {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 204
};

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Created upload directory:', uploadDir);
}

const app = express();
const port = process.env.PORT || 3000;

app.use(cors(corsOptions));
app.use(express.json());
app.use('/uploads/vehicles', express.static('uploads/vehicles'));

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'application/octet-stream'
    ];
    const allowedExtensions = /\.(jpg|jpeg|png|gif|webp)$/i;

    if (allowedTypes.includes(file.mimetype) ||
        (file.originalname && file.originalname.match(allowedExtensions))) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, GIF and WebP are allowed.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

// Get all vehicles
app.get('/api/vehicles', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT v.*, 
            GROUP_CONCAT(DISTINCT vf.feature) as features,
            GROUP_CONCAT(DISTINCT vi.image_url) as images
            FROM vehicles v
            LEFT JOIN vehicle_features vf ON v.id = vf.vehicle_id
            LEFT JOIN vehicle_images vi ON v.id = vi.vehicle_id
            GROUP BY v.id
            ORDER BY v.created_at DESC
        `);

        const vehicles = rows.map(vehicle => ({
            ...vehicle,
            features: vehicle.features ? vehicle.features.split(',') : [],
            images: vehicle.images ? vehicle.images.split(',') : []
        }));

        res.json(vehicles);
    } catch (error) {
        console.error('Error fetching vehicles:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single vehicle
app.get('/api/vehicles/:id', async (req, res) => {
    try {
        console.log('Fetching vehicle with ID:', req.params.id);
        
        const [vehicles] = await pool.query(`
            SELECT v.*, 
            GROUP_CONCAT(DISTINCT vf.feature) as features,
            GROUP_CONCAT(DISTINCT vi.image_url) as images
            FROM vehicles v
            LEFT JOIN vehicle_features vf ON v.id = vf.vehicle_id
            LEFT JOIN vehicle_images vi ON v.id = vi.vehicle_id
            WHERE v.id = ?
            GROUP BY v.id
        `, [req.params.id]);

        if (vehicles.length === 0) {
            console.log('Vehicle not found:', req.params.id);
            return res.status(404).json({ error: 'Vehicle not found' });
        }

        const vehicle = {
            ...vehicles[0],
            features: vehicles[0].features ? vehicles[0].features.split(',') : [],
            images: vehicles[0].images ? vehicles[0].images.split(',') : []
        };

        console.log('Returning vehicle data:', vehicle);
        res.json(vehicle);
    } catch (error) {
        console.error('Error fetching vehicle:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create vehicle
app.post('/api/vehicles', upload.array('images', 10), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { brand, model, year, price, mileage, fuelType, transmission, power, description, status } = req.body;
        let features = [];
        try {
            features = JSON.parse(req.body.features || '[]');
        } catch (e) {
            console.warn('Could not parse features:', e);
        }

        const [vehicleResult] = await connection.query(
            'INSERT INTO vehicles (brand, model, year, price, mileage, fuel_type, transmission, power, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [brand, model, year, price, mileage, fuelType, transmission, power, description, status || 'available']
        );

        const vehicleId = vehicleResult.insertId;

        if (features.length > 0) {
            const featureValues = features.map(feature => [vehicleId, feature]);
            await connection.query(
                'INSERT INTO vehicle_features (vehicle_id, feature) VALUES ?',
                [featureValues]
            );
        }

        if (req.files && req.files.length > 0) {
            const imageValues = req.files.map((file, index) => [
                vehicleId,
                `/uploads/vehicles/${file.filename}`,
                index
            ]);

            await connection.query(
                'INSERT INTO vehicle_images (vehicle_id, image_url, sort_order) VALUES ?',
                [imageValues]
            );
        }

        await connection.commit();

        const [vehicle] = await connection.query(`
            SELECT v.*, 
            GROUP_CONCAT(DISTINCT vf.feature) as features,
            GROUP_CONCAT(DISTINCT vi.image_url) as images
            FROM vehicles v
            LEFT JOIN vehicle_features vf ON v.id = vf.vehicle_id
            LEFT JOIN vehicle_images vi ON v.id = vi.vehicle_id
            WHERE v.id = ?
            GROUP BY v.id
        `, [vehicleId]);

        res.status(201).json({
            message: 'Vehicle created successfully',
            vehicle: {
                ...vehicle[0],
                features: vehicle[0].features ? vehicle[0].features.split(',') : [],
                images: vehicle[0].images ? vehicle[0].images.split(',') : []
            }
        });

    } catch (error) {
        await connection.rollback();
        console.error('Error creating vehicle:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// Update vehicle
app.put('/api/vehicles/:id', upload.array('images', 10), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const vehicleId = req.params.id;
        const { brand, model, year, price, mileage, fuelType, transmission, power, description, status } = req.body;
        
        await connection.query(
            'UPDATE vehicles SET brand = ?, model = ?, year = ?, price = ?, mileage = ?, fuel_type = ?, transmission = ?, power = ?, description = ?, status = ? WHERE id = ?',
            [brand, model, year, price, mileage, fuelType, transmission, power, description, status, vehicleId]
        );

        // Update features
        await connection.query('DELETE FROM vehicle_features WHERE vehicle_id = ?', [vehicleId]);
        if (req.body.features) {
            const features = JSON.parse(req.body.features);
            if (features.length > 0) {
                const featureValues = features.map(feature => [vehicleId, feature]);
                await connection.query(
                    'INSERT INTO vehicle_features (vehicle_id, feature) VALUES ?',
                    [featureValues]
                );
            }
        }

        // Handle new images
        if (req.files && req.files.length > 0) {
            const imageValues = req.files.map((file, index) => [
                vehicleId,
                `/uploads/vehicles/${file.filename}`,
                index
            ]);

            await connection.query(
                'INSERT INTO vehicle_images (vehicle_id, image_url, sort_order) VALUES ?',
                [imageValues]
            );
        }

        await connection.commit();

        const [vehicle] = await connection.query(`
            SELECT v.*, 
            GROUP_CONCAT(DISTINCT vf.feature) as features,
            GROUP_CONCAT(DISTINCT vi.image_url) as images
            FROM vehicles v
            LEFT JOIN vehicle_features vf ON v.id = vf.vehicle_id
            LEFT JOIN vehicle_images vi ON v.id = vi.vehicle_id
            WHERE v.id = ?
            GROUP BY v.id
        `, [vehicleId]);

        res.json({
            message: 'Vehicle updated successfully',
            vehicle: {
                ...vehicle[0],
                features: vehicle[0].features ? vehicle[0].features.split(',') : [],
                images: vehicle[0].images ? vehicle[0].images.split(',') : []
            }
        });

    } catch (error) {
        await connection.rollback();
        console.error('Error updating vehicle:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// Delete vehicle
app.delete('/api/vehicles/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Get image paths before deleting
        const [images] = await connection.query(
            'SELECT image_url FROM vehicle_images WHERE vehicle_id = ?',
            [req.params.id]
        );

        // Delete from database
        await connection.query('DELETE FROM vehicles WHERE id = ?', [req.params.id]);

        // Delete image files
        images.forEach(image => {
            const imagePath = path.join(projectRoot, image.image_url);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        });

        await connection.commit();
        res.json({ message: 'Vehicle deleted successfully' });

    } catch (error) {
        await connection.rollback();
        console.error('Error deleting vehicle:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        const connection = await pool.getConnection();
        await connection.query('SELECT 1');
        connection.release();

        res.json({
            status: 'healthy',
            message: 'Server is running and database is connected',
            uploadDir: uploadDir,
            corsOrigins: corsOptions.origin
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Error Handling
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        console.error('Multer error:', error);
        return res.status(400).json({
            error: 'File upload error',
            message: error.message
        });
    }
    next(error);
});

// Start server
const startServer = async () => {
    try {
        fs.accessSync(uploadDir, fs.constants.W_OK);
        console.log('Upload directory is writable');

        const connection = await pool.getConnection();
        console.log('Database connection successful');
        connection.release();

        app.listen(port, () => {
            console.log(`Server is running on http://localhost:${port}`);
            console.log('Upload directory configured at:', uploadDir);
            console.log('CORS enabled for:', corsOptions.origin);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();