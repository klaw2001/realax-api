import * as authenticationController from './authController'
import { route } from '@/@core/helpers/router'

const router = route()

router.post('/login', authenticationController.login)
router.post('/access-token', authenticationController.getAccessToken)

export default router.router
