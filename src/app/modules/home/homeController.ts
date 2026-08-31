import { Request, Response } from 'express'
import { sendResponse } from '@core/services/ResponseService'
import statusType from '@core/enum/statusTypes'
import logger from '@core/services/LoggingService'

export async function getHome(req: Request, res: Response) {

    try {

        

        return sendResponse(res, true, null, 'get home routes')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getHome ', error)
        return sendResponse(res, false, null, 'Error ', statusType.DB_ERROR)
    }
}

export async function postHome(req: Request, res: Response) {

    try {



        return sendResponse(res, true, null, 'post home routes')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in postHome', error)
        return sendResponse(res, false, null, 'Error ', statusType.DB_ERROR)
    }
}
