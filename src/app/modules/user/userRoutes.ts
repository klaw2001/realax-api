import * as Controller from './userController'
import writeAccessMiddleware from '@/app/middlewares/writeAccessMiddleware'
import { route } from '@/@core/helpers/router'

const router = route()



router.get('/all',Controller.getAllUsers)
router.get('/single/:user_id', Controller.getAllUsers)
router.post('/save', writeAccessMiddleware('user'), Controller.saveUser)

export default router.router
