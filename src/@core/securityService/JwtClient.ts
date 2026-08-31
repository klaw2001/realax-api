import jwt from 'jsonwebtoken'
import logger from '@core/services/LoggingService'


export function jwtRefreshTokenEncode(payload: any) {
    try {

        if (!process.env.JWT_REFRESH_SECRET || !process.env.JWT_REFRESH_TOKEN_EXPIRE) {
            throw new Error('JWT_REFRESH_SECRET or JWT_REFRESH_TOKEN_EXPIRE not defined in env')
        }

         
        return jwt.sign({ data: payload }, process.env.JWT_REFRESH_SECRET as any, { expiresIn: process.env.JWT_REFRESH_TOKEN_EXPIRE } as any)
    } catch (error) {
        logger.consoleErrorLog('core', 'Error in jwtRefreshTokenEncode', error)
        return null
    }
}

export function jwtRefreshTokenVerify(token: string) {
    try {

        if (!process.env.JWT_REFRESH_SECRET) {
            throw new Error('JWT_REFRESH_SECRET not defined in env')
        }

         
        return jwt.verify(token, process.env.JWT_REFRESH_SECRET)
    } catch (error) {
        // logger.consoleErrorLog('core', 'Error in jwtRefreshTokenVerify', error)
        return null
    }
}

export function jwtAccessTokenEncode(payload: any) {
    try {

        if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_ACCESS_TOKEN_EXPIRE) {
            throw new Error('JWT_ACCESS_SECRET or JWT_ACCESS_TOKEN_EXPIRE not defined in env')
        }

         
        return jwt.sign({ data: payload,  }, process.env.JWT_ACCESS_SECRET as any, { expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRE } as any)
    } catch (error) {
        logger.consoleErrorLog('core', 'Error in jwtAccessTokenEncode', error)
        return null
    }
}

export function jwtAccessTokenVerify(token: string) {
    try {

        if (!process.env.JWT_ACCESS_SECRET) {
            throw new Error('JWT_ACCESS_SECRET not defined in env')
        }

         
        return jwt.verify(token, process.env.JWT_ACCESS_SECRET)
    } catch (error) {
        logger.consoleErrorLog('core', 'Error in jwtAccessTokenVerify', error)
        return null
    }
}

export function jwtDecode(token: string) {
    try {
        return jwt.decode(token)
    } catch (error) {
        logger.consoleErrorLog('core', 'Error in jwtDecode', error)
        return null
    }
}
