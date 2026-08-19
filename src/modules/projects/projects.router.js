import express from 'express';
import { ProjectsRepository } from './projects.repository.js';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router();

// All project routes require authentication
router.use(protect);

router.get('/', async (req, res, next) => {
  try {
    const projects = await ProjectsRepository.findAll();
    res.status(200).json({
      status: 'success',
      results: projects.length,
      data: {
        projects
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await ProjectsRepository.findById(req.params.id);
    if (!project) {
      return next(new AppError('No project found with that ID', 404));
    }
    res.status(200).json({
      status: 'success',
      data: {
        project
      }
    });
  } catch (error) {
    next(error);
  }
});

// Only ADMIN can create projects
router.post('/', restrictTo('ADMIN'), async (req, res, next) => {
  try {
    const { name, code, developer_name, address, description, currency } = req.body;
    
    // Check if code exists
    const existing = await ProjectsRepository.findByCode(code);
    if (existing) {
      return next(new AppError('Project with this code already exists', 400));
    }

    const newProject = await ProjectsRepository.create({
      name, code, developer_name, address, description, currency
    });

    res.status(201).json({
      status: 'success',
      data: {
        project: newProject
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
