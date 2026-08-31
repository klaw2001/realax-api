export default function dataObjectBuilder(body: any) {

    const dataObject: any = {}

    function addIfValueExists(key: string, filterFn?: Function) {
        if (body[key] !== undefined) {
            if (filterFn) {
                const val = filterFn(body[key])
                dataObject[key] = val
            } else {
                dataObject[key] = body[key]
            }
        }

        return {
            addIfValueExists,
            removeValue,
            getDataObject,
            dataObject
        }
    }

    function removeValue(key: string) {
        delete dataObject[key]

        return {
            addIfValueExists,
            removeValue,
            getDataObject,
            dataObject
        }
    }

    function getDataObject() {
        return dataObject
    }

    return {
        addIfValueExists,
        removeValue,
        getDataObject,
        dataObject
    }
}
