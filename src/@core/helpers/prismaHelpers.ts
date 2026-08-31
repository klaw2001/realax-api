import { getIntOrNull, getStringOrNull } from './commonHelpers'
import knex from './knex'

interface rowFlags {
    status?: any,
    archived?: any,
    deleted?: any,
}

export function whereIfValue(options: any, col_name: string, value: any, filterFunction: Function) {
    value = filterFunction(value)
    if (value !== undefined && value !== null) {

        if (!options.where) { options.where = {} }

        options.where[col_name] = value
    }
}

export function whereSomeIfValue(options: any, relation_name: string, col_name: string, value: any, filterFunction: Function) {
    value = filterFunction(value)
    if (value !== undefined && value !== null) {

        if (!options.where) { options.where = {} }

        options.where[relation_name] = { some: {} }
        options.where[relation_name].some[col_name] = value
    }
}

export function whereIfFlag(options: any, col_name: string, flag_value: any) {

    if (typeof flag_value === 'number') {
        flag_value = flag_value.toString()
    }

    if (flag_value === '1' || flag_value === '0') {

        if (!options.where) { options.where = {} }

        options.where[col_name] = flag_value === '1' ? true : false
    }

}


export function whereIfFlags(options: any, prefix: string, flags: rowFlags) {
    whereIfFlag(options, `${prefix}_status`, flags.status)
    whereIfFlag(options, `${prefix}_archived`, flags.archived)
    whereIfFlag(options, `${prefix}_deleted`, flags.deleted)
}

export function applyIfLimit(options: any, limit: any) {

    limit = getIntOrNull(limit)
    if (limit) {
        options.take = limit
    }

}

export function applyIfOffset(options: any, offset: any) {

    offset = getIntOrNull(offset)
    if (offset) {
        options.skip = offset
    }

}

export function likeIfValue(options: any, cols: any[], search: any) {

    search = getStringOrNull(search)

    if (search) {

        const OR: any[] = []

        for (const col of cols) {

            if (col && Array.isArray(col)) {
                const obj: any = {}
                const searchArr = search.split(' ')
                for (let i = 0; i < col.length; i++) {
                    const inner_col = col[i]
                    obj[inner_col] = { contains: searchArr[i] }
                }
                OR.push(obj)
            } else {
                const obj: any = {}
                obj[col] = { contains: search }
                OR.push(obj)
            }
        }

        if (!options.where) { options.where = {} }

        options.where.OR = OR

        // OR: [
        //     {
        //         t_first_name: {
        //             contains: search
        //         },
        //         t_last_name: {
        //             contains: search
        //         },
        //     },
        //     {
        //         t_mobile: {
        //             contains: search
        //         }
        //     },
        //     {
        //         t_email: {
        //             contains: search
        //         }
        //     }
        // ]

    }

}

export async function checkExists(
    table: string,
    prefix: string,
    id: number | null,
    columns: string[],
    values: any[],
) {

    if (columns.length !== values.length) {
        throw new Error('columns and values array lengths does not match')
    }

    const cols: string[] = []
    const vals: any[] = []

    // Filter undefined and null values
    for (let i = 0; i < values.length; i++) {
        if (values[i] !== undefined && values[i] !== null) {
            cols.push(columns[i])
            vals.push(values[i])
        }
    }

    if (!vals.length) {
        return {
            data: undefined,
            message: ''
        }
    }

    const [checkExists] = await knex(table)
        .where((builder) => {
            for (let i = 0; i < cols.length; i++) {
                builder.orWhere(cols[i], vals[i])
            }
        })
        .where((builder) => {
            if (id) {builder.whereNot(`${prefix}_id`, id)}
            builder.where(`${prefix}_deleted`, '0')
        })

    let message = ''
    for (let i = 0; i < columns.length; i++) {
        if (checkExists[columns[i]] === values[i]) {
            message = `Feild ${columns[i]} cannot be duplicate`
            break
        }
    }

    return {
        data: checkExists,
        message
    }

}