import { NextFunction, Request, Response, Router } from 'express'
import express from 'express'

export function post(router: Router, path: string, handler: any) {
    router.post(path, (req: Request, res: Response, next: NextFunction) => handler(req, res, next).catch(next))
}

export function get(router: Router, path: string, handler: any) {
    router.get(path, (req: Request, res: Response, next: NextFunction) => handler(req, res, next).catch(next))
}

export function route() {
    const router = express.Router()

    function get(path: string, ...handlers: Function[]) {
        router.get(path, ...handlers.map(handler => (req: Request, res: Response, next: NextFunction) => handler(req, res, next).catch(next)))
    }

    function post(path: string, ...handlers: Function[]) {
        router.post(path, ...handlers.map(handler => (req: Request, res: Response, next: NextFunction) => handler(req, res, next).catch(next)))
    }

    return {
        get,
        post,
        router
    }
}

export function asyncHandler() {

}
