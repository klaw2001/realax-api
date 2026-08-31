import path from 'path'

import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import fileUpload from 'express-fileupload'
import cookieParser from 'cookie-parser'

import appRoutes from '@/app/router'
import healthRoutes from '@/modules/health/health.routes'

const app = express()

 
app.set('port', process.env.PORT || 4000)
app.use(express.static('public'))
app.use(bodyParser.json({ limit: '5mb' }))

// The frontend is a separate origin and will send a session cookie, so the
// allowed origin has to be explicit — `*` is invalid with credentials.
app.use(
    cors({
         
        origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
        credentials: true
    })
)
app.use(cookieParser())
app.use(
    fileUpload({ limits: { fileSize: 5 * 1024 * 1024 }, safeFileNames: false, abortOnLimit: true })
)

app.use('/health', healthRoutes)

// Served so the frontend can run `gen:api` against a running dev server
// instead of reaching across repos for the file.
app.get('/openapi.json', (_req, res) => {
     
    res.sendFile(path.resolve(process.cwd(), 'openapi.json'))
})

app.use('/api', appRoutes)

export default app
