import cloudinary from '../../utils/cloudinary.js';
import streamifier from 'streamifier';

export const uploadImage = (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: { code: 'NO_FILE', message: 'No image file provided' }
            });
        }

        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'tozon-crm' },
            (error, result) => {
                if (error) {
                    return res.status(500).json({
                        success: false,
                        error: { code: 'UPLOAD_FAILED', message: error.message }
                    });
                }
                
                res.json({
                    success: true,
                    data: {
                        url: result.secure_url,
                        publicId: result.public_id,
                        width: result.width,
                        height: result.height
                    }
                });
            }
        );

        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
    } catch (err) {
        console.error('Upload Error:', err);
        res.status(500).json({
            success: false,
            error: { code: 'INTERNAL_ERROR', message: err.message }
        });
    }
};
