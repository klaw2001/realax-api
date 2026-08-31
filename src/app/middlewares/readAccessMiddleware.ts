import { Request, Response, NextFunction } from 'express'
import { sendResponse } from '@core/services/ResponseService'
import statusType from '@core/enum/statusTypes'
import prisma from '@core/helpers/prisma'
import logger from '@core/services/LoggingService'

export default function readAccessMiddleware(module_key: string) {

    return function (req: Request, res: Response, next: NextFunction) {
        (async () => {
            try {

                const user: any = req.userInfo

                if (!user || !user.user_role_id) {
                    return sendResponse(res, false, null, 'User has no role', statusType.UNAUTHORIZED)
                }

                const find = await prisma.module_role_map.findFirst({
                    where: {
                        mrm_role_id: user.user_role_id,
                        mrm_module: {
                            module_key: module_key
                        },
                        mrm_read: true,
                        mrm_status: true,
                        mrm_deleted: false,
                        mrm_archived: false
                    }
                })

                if (!find) {
                    return sendResponse(res, false, null, '', statusType.UNAUTHORIZED)
                }

                next()

            } catch (error) {
                logger.consoleErrorLog(req.originalUrl, 'Error in accessMiddleware ', error)
                return sendResponse(res, false, null, 'Error in validating token', statusType.INTERNAL_SERVER_ERROR)
            }
        })()
    }
}
