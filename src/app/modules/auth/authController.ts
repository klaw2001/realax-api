import { Request, Response } from 'express'
import { sendResponse } from '@core/services/ResponseService'
import statusType from '@core/enum/statusTypes'
import logger from '@core/services/LoggingService'
import { validateLogin, validateRegister } from '@core/helpers/validationHelper'
import prisma from '@core/helpers/prisma'
import { hash } from '@core/securityService/CryptoClient'
import { jwtAccessTokenEncode, jwtRefreshTokenEncode, jwtRefreshTokenVerify } from '@core/securityService/JwtClient'

export async function login(req: Request, res: Response) {

    try {

        const body = {
            email: req.body.email,
            password: req.body.password,
        }

        const validate = validateLogin(body)

        if (!validate) {
            return sendResponse(res, false, null, 'Fields validation failed!')
        }

        const user = await prisma.users.findFirst({
            where: {
                user_email: body.email,
                user_status: true
            }
        })

        if (!user) {
            return sendResponse(res, false, null, 'No Such User')
        }

        if (user.user_password !== hash(body.password)) {
            return sendResponse(res, false, null, 'Password does not match')
        }

        const payload = { user_id: user.user_id }
        const refreshToken = jwtRefreshTokenEncode(payload)

        return sendResponse(res, true, refreshToken, 'Login Successfull')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in login', error)
        return sendResponse(res, false, null, 'Error in login', statusType.DB_ERROR)
    }
}

export async function register(req: Request, res: Response) {

    try {

        const body = {
            email: req.body.email,
            password: req.body.password,
            firstname: req.body.firstname,
            lastname: req.body.lastname,
            mobile: req.body.mobile,
        }

        const validate = validateRegister(body)
        if (!validate) {
            return sendResponse(res, false, null, 'Fields validation failed!')
        }

        const hashPassword: string = hash(body.password)

        if (!hashPassword) {
            return sendResponse(res, false, null, 'Cannot hash password', statusType.INTERNAL_SERVER_ERROR)
        }

        const insertUser = await prisma.users.create({
            data: {
                user_email: body.email,
                user_mobile: body.mobile,
                user_password: hashPassword,
                user_first_name: body.firstname,
                user_last_name: body.lastname
            }
        })

        const payload = { user_id: insertUser.user_id }
        const refreshToken = jwtRefreshTokenEncode(payload)

        return sendResponse(res, true, refreshToken, 'Registration Successfull')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in register', error)
        return sendResponse(res, false, null, 'Error in register', statusType.DB_ERROR)
    }
}

export async function getAccessToken(req: Request, res: Response) {

    try {

        const refreshToken = req.body.refreshToken

        if (!refreshToken || typeof refreshToken !== 'string') {
            return sendResponse(res, false, null, 'refresh token not provided')
        }

        const decoded = jwtRefreshTokenVerify(refreshToken)

        if (!decoded || typeof decoded !== 'object') {
            return sendResponse(res, false, null, 'Refresh Token No Valid', statusType.UNAUTHORIZED)
        }

        const user = await prisma.users.findFirst({
            where: {
                user_id: decoded.user_id,
                user_status: true
            }
        })

        if (!user) {
            return sendResponse(res, false, null, 'No such user!')
        }

        const payload = { user_id: user.user_id }
        const accessToken = jwtAccessTokenEncode(payload)

        return sendResponse(res, true, accessToken, 'Access Token')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getAccessToken', error)
        return sendResponse(res, false, null, 'Error in getting access token', statusType.DB_ERROR)
    }
}
