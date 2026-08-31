import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {

    await prisma.sys_module.createMany({
        data: [
            {
                module_id: 1,
                module_key: 'user',
                module_name: 'User',
            },
            {
                module_id: 2,
                module_key: 'role',
                module_name: 'Role',
            },
        ],
        skipDuplicates: true
    });

    await prisma.roles.createMany({
        data: [
            {
                role_id: 1,
                role_key: 'admin',
                role_name: 'Admin'
            },
        ],
        skipDuplicates: true
    });

    await prisma.module_role_map.createMany({
        data: [
            {
                mrm_module_id: 1,
                mrm_role_id: 1,
                mrm_read: true,
                mrm_write: true
            },
            {
                mrm_module_id: 2,
                mrm_role_id: 1,
                mrm_read: true,
                mrm_write: true
            },
        ],
        skipDuplicates: true
    });

    // Creating admin user
    await prisma.users.createMany({
        data: [{
            user_id: 1,
            user_email: 'admin@mail.in',
            user_mobile: '919807654321',
            user_password: '21232f297a57a5a743894a0e4a801fc3', //admin
            user_first_name: 'Admin',
            user_last_name: 'user',
            user_role_id: 1
        }],
        skipDuplicates: true
    })
}

main()
    .catch((e) => {
        console.error(e)
        // eslint-disable-next-line no-undef
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
