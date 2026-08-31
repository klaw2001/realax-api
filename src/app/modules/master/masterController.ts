import { sendResponse } from '@/@core/services/ResponseService'
import { NextFunction, Request, Response } from 'express'
import prisma from '@/@core/helpers/prisma'
import statusType from '@core/enum/statusTypes'
import logger from '@core/services/LoggingService'
import { getIntOrNull, getObjOrNull, getTrueOrFalse } from '@/@core/helpers/commonHelpers'
import { applyIfLimit, applyIfOffset, likeIfValue, whereIfFlag, whereIfValue } from '@/@core/helpers/prismaHelpers'
import knex from '@/@core/helpers/knex'



export async function getUserProfile(req: Request, res: Response, next: NextFunction) {
    try {
        const { user_id } = req.userInfo

        const user = await prisma.users.findFirst({
            select: {
                user_id: true,
                user_email: true,
                user_mobile: true,
                user_first_name: true,
                user_last_name: true,
                user_role_id: true,
                // user_role: {
                //     select: {
                //         role_name: true
                //     }
                // }
            },
            where: {
                user_id
            }
        })

        if (!user) {
            return sendResponse(res, false, null, 'No such user found')
        }

        await knex.raw('SET sql_mode=(SELECT REPLACE(@@sql_mode,\'ONLY_FULL_GROUP_BY\',\'\')); ')
        await knex.raw('SET SESSION group_concat_max_len = 1000000;')

        const access_map = await knex('sys_module as sm')
            .select('sm.module_name', 'sm.module_key', 'mrm.mrm_read', 'mrm.mrm_write')
            .leftJoin('module_role_map as mrm', 'mrm.mrm_module_id', 'sm.module_id')
            .leftJoin('roles as r', 'r.role_id', 'mrm.mrm_role_id')
            .where({
                'mrm.mrm_status': 1,
                'sm.module_status': 1,
                'r.role_id': user.user_role_id
            })
            .groupBy('sm.module_id')

        // const query = knex('sys_module').select('sys_module.module_id', 'sys_module.module_name');

        // if(user?.user_role_id && isNaN(user?.user_role_id)) {
        //     query.select(
        //         'module_role_map.mrm_id',
        //         'module_role_map.role_id',
        //         'module_role_map.read',
        //         'module_role_map.write',
        //     );
        // }

        // query.leftJoin('module_role_map', function () {
        //     this.on('module_role_map.mrm_module_id', 'sys_module.module_id');
        //     if (user?.user_role_id && isNaN(user.user_role_id)) {
        //         this.andOnVal('module_role_map.role_id', user.user_role_id);
        //         this.andOnVal('module_role_map.status', 1);
        //     }
        // }).groupBy('sys_module.module_id');

        return sendResponse(res, true, { user, access_map }, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getUserProfile', error)
        return sendResponse(res, false, null, 'Error ', statusType.DB_ERROR)
    }
}

export async function getAllUsers(req: Request, res: Response) {
    try {
        const data = await prisma.users.findMany({
            where: {
                user_status: true
            }
        })
        return sendResponse(res, true, data, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getUsers', error)
        return sendResponse(res, false, null, 'Error in getting users', statusType.DB_ERROR)
    }
}

export async function getAllActiveRoles(req: Request, res: Response) {
    try {
        const data = await prisma.roles.findMany({
            select: {
                role_id: true,
                role_name: true
            },
            where: {
                role_status: true,
                role_deleted: false,
                role_archived: false
            }
        })

        return sendResponse(res, true, data, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getAllRoles', error)
        return sendResponse(res, false, null, 'Error ', statusType.DB_ERROR)
    }
}

export async function getAllModules(req: Request, res: Response) {
    try {
        const data = await prisma.sys_module.findMany({
            where: {
                module_status: true,
                module_archived: false,
                module_deleted: false
            }
        })

        return sendResponse(res, true, data, 'success')
    } catch (error) {
        logger.consoleErrorLog(req.originalUrl, 'Error in getAllModules', error)
        return sendResponse(res, false, null, 'Error ', statusType.DB_ERROR)
    }
}
