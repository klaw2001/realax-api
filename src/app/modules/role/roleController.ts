import { Request, Response } from 'express'
import { sendResponse } from '@core/services/ResponseService'
import statusType from '@core/enum/statusTypes'
import logger from '@core/services/LoggingService'
import { applyIfLimit, applyIfOffset, likeIfValue, whereIfFlags } from '@core/helpers/prismaHelpers'
import prisma from '@core/helpers/prisma'
import { getArrayOrNull, getIntOrNull, getStringOrNull, getTrueOrFalse } from '@core/helpers/commonHelpers'
import dataObjectBuilder from '@core/helpers/dataObjectBuilder'
import { roles } from '@prisma/client'

export async function getAllRoles(req: Request, res: Response) {

    try {

        const { search, status, archived, deleted, limit, offset } = req.query

        const options: any = {}

        whereIfFlags(options, 'role', { status, archived, deleted })

        likeIfValue(options, ['role_name'], search)

        const count = await prisma.roles.count(options)

        applyIfLimit(options, limit)

        applyIfOffset(options, offset)

        const roles = await prisma.roles.findMany(options)

        const data = {
            total: count,
            rows: roles
        }

        return sendResponse(res, true, data, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getAllRoles', error)
        return sendResponse(res, false, null, 'Error getting all roles', statusType.DB_ERROR)
    }
}

export async function getSingleRole(req: Request, res: Response) {

    try {

        const role_id = getIntOrNull(req.params.role_id)

        if (!role_id) {
            return sendResponse(res, false, null, 'role_id not valid')
        }

        const role: any = await prisma.roles.findFirst({
            where: {
                role_id
            }
        })

        const module_role_map_arr = await prisma.sys_module.findMany({
            include: {
                module_role_map: {
                    select: {
                        mrm_module_id: true,
                        mrm_read: true,
                        mrm_write: true,
                        mrm_status: true
                    },
                    where: {
                        mrm_role_id: role_id,
                        mrm_status: true
                    }
                }
            },
            where: {
                module_status: true
            }
        })

        const module_role_map: any[] = []
        for (const d of module_role_map_arr) {
            module_role_map.push({
                module_id: d.module_id,
                module_name: d.module_name,
                module_key: d.module_key,
                read: d.module_role_map[0]?.mrm_read || false,
                write: d.module_role_map[0]?.mrm_write || false,
            })
        }

        const data: any = {
            ...role,
            module_role_map
        }

        return sendResponse(res, true, data, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getSingleRole', error)
        return sendResponse(res, false, null, 'Error getting single role', statusType.DB_ERROR)
    }
}

export async function saveRole(req: Request, res: Response) {

    try {

        const data: any = dataObjectBuilder(req.body)
            .addIfValueExists('role_name', getStringOrNull)
            .addIfValueExists('role_status', getTrueOrFalse)
            .addIfValueExists('role_archive', getTrueOrFalse)
            .addIfValueExists('role_delete', getTrueOrFalse)
            .getDataObject()

        let role_id = getIntOrNull(req.body.role_id)
        let role: roles

        if (role_id) {
            role = await prisma.roles.update({
                where: {
                    role_id
                },
                data
            })
        } else {
            role = await prisma.roles.create({
                data
            })

            role_id = role.role_id
        }

        const module_map = getArrayOrNull(req.body.module_role_map)

        if (module_map && module_map.length) {

            await prisma.module_role_map.updateMany({
                where: {
                    mrm_role_id: role_id
                },
                data: {
                    mrm_status: false,
                    mrm_deleted: true
                }
            })

            const insertArr: any[] = []
            for (const d of module_map) {
                const module_id = getIntOrNull(d.module_id)

                if (!module_id) {
                    continue
                }

                insertArr.push({
                    mrm_module_id: module_id,
                    mrm_role_id: role_id,
                    mrm_read: d.read,
                    mrm_write: d.write,
                    mrm_status: true
                })
            }
            await prisma.module_role_map.createMany({
                data: insertArr
            })
        }

        return sendResponse(res, true, null, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in saveRole', error)
        return sendResponse(res, false, null, 'Error saving role', statusType.DB_ERROR)
    }
}
