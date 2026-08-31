export const checkEmail = (email: string) => {
    const emailRegex = /\S+@\S+\.\S+/
    if (emailRegex.test(email)) {
        return true
    }
    return false
}

export const validateLogin = (body: any) => {
    const isEmail = checkEmail(body.email)
    const isPassword = body.password && body.password.length < 40
    if (isEmail && isPassword) {
        return true
    } else {
        return false
    }
}

export const validateRegister = (body: any) => {
    const isEmail = checkEmail(body.email)
    const isPassword = body.password && body.password.length < 40
    const isFirstname = body.firstname && body.firstname.length < 20
    const isLastname = body.lastname && body.lastname.length < 20
    // const isMobile = body.mobile && body.mobile.length <= 12 && body.mobile.length >= 10 && !isNaN(body.mobile)

    if (isEmail && isPassword && isFirstname && isLastname) {
        return true
    } else {
        return false
    }
}