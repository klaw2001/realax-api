import { Response } from 'express'

export function sendResponse(res: Response, status: boolean, data: any, message: string, statusCode: number = 200, apiVersion: string = '') {
    const obj = {
        status,
        data,
        message,
        apiVersion: apiVersion || 'No Version',
    }

    return res.status(statusCode).json(obj)
};
