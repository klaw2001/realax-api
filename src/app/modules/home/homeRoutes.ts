import * as homeController from './homeController'
import { route } from '@/@core/helpers/router'

const router = route()

router.get('/', homeController.getHome)
router.post('/', homeController.postHome)

export default router.router
