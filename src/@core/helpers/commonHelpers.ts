import moment from 'moment'

import { MYSQL_MOMENT_DATETIME_FORMAT, MYSQL_MOMENT_DATE_FORMAT } from './constant'

export function getDateTimeOrNull(item: any) {
  try {
    if (item && moment(item).isValid()) {
      return moment(item).format(MYSQL_MOMENT_DATETIME_FORMAT)
    }

    return null
  } catch (err) {
    return null
  }
}

export function getDateOrNull(item: any) {
  try {
    if (item && moment(item).isValid()) {
      return moment(item).toDate()
    }

    return null
  } catch (err) {
    return null
  }
}

export function getDateOrCurrentDate(item: any) {
  try {
    if (item && moment(item).isValid()) {
      return moment(item).startOf('day').toDate()
    }
    return moment().startOf('day').toDate()
  } catch (err) {
    return moment().startOf('day').toDate()
  }
}

export function getStringOrNull(item: any) {
  try {
    if (item === '' || item === null || item === undefined) {
      return null
    }

    if (item && typeof item === 'string') {
      return item
    }

    if (item && item.toString) {
      return item.toString()
    }

    return JSON.stringify(item)
  } catch (error) {
    return null
  }
}

export function getOneOrZero(item: any) {
  return !item || item === '0' || item === 'false' ? '0' : '1'
}

export function getObjOrNull(obj: any) {
  return obj ? obj : null
}

export function getObjOrUndefined(value: any) {
  try {
    if (!value) {
      return undefined
    }
    return value
  } catch (err) {
    return undefined
  }
}

export function getIntOrNull(val: any) {
  try {
    if (val !== null && val !== undefined && !isNaN(val) && parseInt(val) >= 0) {
      return parseInt(val)
    }
    return null
  } catch (err) {
    return null
  }
}

export function getNumberOrZero(val: any) {
  try {
    if (val && !isNaN(val)) {
      return Number(val)
    }
    return 0
  } catch (err) {
    return 0
  }
}

export function getNumberOrOne(val: any) {
  try {
    if (val && !isNaN(val)) {
      return Number(val)
    }
    return 1
  } catch (err) {
    return 1
  }
}

export function getDoubleOrNull(val: any) {
  try {
    if (!isNaN(val) && parseInt(val) >= 0) {
      return Number(val).toFixed(2)
    }
    return null
  } catch (err) {
    return null
  }
}

export function getDoubleOrZero(val: any) {
  try {
    if (val && !isNaN(val)) {
      return Number(val).toFixed(2)
    }
    return 0
  } catch (err) {
    return 0
  }
}

export function getIntOrZero(val: any) {
  try {
    if (!isNaN(val) && parseInt(val) >= 0) {
      return parseInt(val)
    }
    return 0
  } catch (err) {
    return 0
  }
}

export function getIntOrUndefined(val: any) {
  try {
    if (!isNaN(val) && Number.isInteger(val)) {
      return parseInt(val)
    }
    return undefined
  } catch (err) {
    return undefined
  }
}

export function getTrueOrFalse(value: any) {
  if (value === true || value === '1' || (typeof value === 'string' && value.toLocaleLowerCase() === 'true')) {
    return true
  }
  return false
}

export function getArrayOrNull(value: any) {
  try {
    if (value && Array.isArray(value)) {
      return value
    } else if (value !== undefined || value !== null) {
      return [value]
    }
    return null
  } catch (error) {
    return null
  }
}

export function getArrayFirstElementOrNull(value: any) {
  try {
    if (value && Array.isArray(value)) {
      return value[0]
    }
    return null
  } catch (error) {
    return null
  }
}

export function getApprovalStatusOrNull(val: any) {
  if (typeof val === 'string' && ['approved', 'pending', 'rejected'].includes(val)) {
    return val
  }

  return null
}

export function removeRepetitions(array: Array<any>) {
  const new_arr: Array<any> = []
  for (let i = 0; i < array.length; i++) {
    const item = array[i]
    if (!new_arr.includes(item)) {
      new_arr.push(item)
    }
  }
  return new_arr
}

export function getArrayFromStringOrNull(item: any) {
  try {
    if (item) {
      const arr = JSON.parse(item)

      if (Array.isArray(arr)) {
        return arr
      }
      return []
    }
    return []
  } catch (error) {
    if (typeof item === 'string') {
      return [item]
    }

    return []
  }
}

export function getHHmmTimeOrNull(item: string) {
  try {
    const checkValid = moment(item, 'HH:mm', true).isValid()
    return checkValid ? item : null
  } catch (error) {
    return null
  }
}

// This will add property only if it exists on req.body with applying given function to body value
export function addIfPropertyExists(obj: any, body: any, key: string, filterFunction: Function) {
  if (body[key] !== undefined) {
    obj[key] = filterFunction(body[key])
  }
}

export function checkIfValuesNull(vals: any[]) {
  for (const val of vals) {
    if (val === null) {return true}
  }
  return false
}

export function checkIfKeyExists(keys: string[], obj: object) {

  const Objkeys: string[] = Object.keys(obj)

  for (const k of keys) {
    if (!Objkeys.includes(k)) {
      return false
    }
  }

  return true

}
