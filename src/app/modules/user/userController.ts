import { Request, Response } from 'express'
import { sendResponse } from '@core/services/ResponseService'
import statusType from '@core/enum/statusTypes'
import logger from '@core/services/LoggingService'
import knex from '@core/helpers/knex'
import prisma from '@core/helpers/prisma'
import { applyIfLimit, applyIfOffset, likeIfValue, whereIfFlags } from '@core/helpers/prismaHelpers'
import { checkIfKeyExists, getIntOrNull, getStringOrNull, getTrueOrFalse } from '@core/helpers/commonHelpers'
import { hash } from '@core/securityService/CryptoClient'
import dataObjectBuilder from '@core/helpers/dataObjectBuilder'

export async function getAllUsers(req: Request, res: Response) {

    try {

        const { search, status, archived, deleted, limit, offset } = req.query

        const options: any = {}

        whereIfFlags(options, 'user', { status, archived, deleted })

        likeIfValue(
            options,
            [
                ['user_first_name', 'user_last_name'],
                'user_email'
                // 'user_mobile'
            ],
            search
        )

        const count = await prisma.users.count(options)

        applyIfLimit(options, limit)

        applyIfOffset(options, offset)

        const users = await prisma.users.findMany({
            include: {
                user_role_relation: {
                    select: {
                        role_name: true
                    }
                }
            },
            ...options
        })

        const data = {
            total: count,
            rows: users
        }

        return sendResponse(res, true, data, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getAllUsers', error)
        return sendResponse(res, false, null, 'Error in getting all users', statusType.DB_ERROR)
    }
}

export async function getSingleUser(req: Request, res: Response) {

    try {

        const user_id = getIntOrNull(req.params.user_id)

        if (!user_id) {
            return sendResponse(res, false, null, 'user_id not valid')
        }

        const data: any = await prisma.users.findFirst({
            where: {
                user_id
            }
        })

        data.user_password = ''

        return sendResponse(res, true, data, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getSingleUser', error)
        return sendResponse(res, false, null, 'Error getting single user', statusType.DB_ERROR)
    }
}

export async function saveUser(req: Request, res: Response) {

    try {

        const data: any = dataObjectBuilder(req.body)
            .addIfValueExists('user_email', getStringOrNull)
            .addIfValueExists('user_mobile', getStringOrNull)
            .addIfValueExists('user_first_name', getStringOrNull)
            .addIfValueExists('user_last_name', getStringOrNull)
            .addIfValueExists('user_role_id', getIntOrNull)
            .addIfValueExists('user_status', getTrueOrFalse)
            .addIfValueExists('user_archive', getTrueOrFalse)
            .addIfValueExists('user_deleted', getTrueOrFalse)
            .getDataObject()

        const user_id = getIntOrNull(req.body.user_id)
        if (data.user_email || data.user_mobile) {
            const [checkExist] = await knex('users')
                .where((builder) => {
                    if (data.user_email) {builder.orWhere('user_email', data.user_email)}
                    if (data.user_mobile) {builder.orWhere('user_mobile', data.user_mobile)}
                })
                .where(function () {
                    if (user_id) {
                        this.whereNot('user_id', user_id)
                    }
                })

            if (checkExist) {
                return sendResponse(res, false, null, 'user email or mobile already exists')
            }
        }

        const user_password = getStringOrNull(req.body.user_password)

        if (user_password) {
            data.user_password = hash(user_password)
        }

        if (user_id) {
            await prisma.users.update({
                where: {
                    user_id
                },
                data
            })
        } else {

            if (!checkIfKeyExists(['user_email', 'user_mobile', 'user_first_name', 'user_last_name', 'user_role_id'], data)) {
                return sendResponse(res, false, null, '\'user_email\', \'user_mobile\', \'user_first_name\', \'user_last_name\', \'user_role_id\' are required to create new user')
            }

            await prisma.users.create({
                data
            })
        }

        return sendResponse(res, true, null, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in saveUser', error)
        return sendResponse(res, false, null, 'Error saving user', statusType.DB_ERROR)
    }
}
