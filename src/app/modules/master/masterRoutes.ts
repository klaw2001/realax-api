// import express from 'express';
// const router = express.Router();
import * as Controller from './masterController'
import { route } from '@/@core/helpers/router'

const router = route()

router.get('/user-profile', Controller.getUserProfile)
router.get('/users', Controller.getAllUsers)
router.get('/roles', Controller.getAllActiveRoles)
router.get('/modules', Controller.getAllModules)

export default router.router
