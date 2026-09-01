-- DESTRUCTIVE. Drops four Express-starter tables and the rows in them.
--
-- sys_module, roles, module_role_map and users are boilerplate from the
-- starter this service was built on. Nothing in the codebase has read them
-- since the modules that did (src/app/modules/{auth,user,role,master,home})
-- were removed: authentication is session-based against Agent, and there are
-- no roles to map. They were left in place until now only because dropping
-- them destroys data and the build plan requires that to be asked for.
--
-- Row counts at the time this was written: module_role_map 4, sys_module 2,
-- roles 1, users 1. The `users` row is the starter's default account and is
-- unrelated to Agent. Nothing here touches a REALAX table.

-- DropForeignKey
ALTER TABLE "module_role_map" DROP CONSTRAINT "module_role_map_mrm_module_id_fkey";

-- DropForeignKey
ALTER TABLE "module_role_map" DROP CONSTRAINT "module_role_map_mrm_role_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_user_role_id_fkey";

-- DropTable
DROP TABLE "module_role_map";

-- DropTable
DROP TABLE "roles";

-- DropTable
DROP TABLE "sys_module";

-- DropTable
DROP TABLE "users";

