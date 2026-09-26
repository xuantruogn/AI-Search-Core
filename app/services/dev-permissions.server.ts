export const DEV_ROLES = ["OWNER", "ADMIN", "VIEWER"] as const;
export type DevRole = (typeof DEV_ROLES)[number];

export const DEV_PERMISSIONS = [
  "shops.read",
  "usage.read",
  "search.read",
  "financial.read",
  "system.read",
  "system.write",
  "shop_plan.read",
  "shop_plan.write",
  "shop_quota.read",
  "shop_quota.write",
  "audit.read",
  "dev_users.read",
  "dev_users.write",
  "secrets.rotate",
] as const;

export type DevPermission = (typeof DEV_PERMISSIONS)[number];

const READ_ONLY: DevPermission[] = [
  "shops.read",
  "usage.read",
  "search.read",
  "system.read",
  "shop_plan.read",
  "shop_quota.read",
];

const ROLE_PERMISSIONS: Record<DevRole, ReadonlySet<DevPermission>> = {
  OWNER: new Set(DEV_PERMISSIONS),
  ADMIN: new Set([
    ...READ_ONLY,
    "financial.read",
    "shop_plan.write",
    "shop_quota.write",
    "audit.read",
  ]),
  VIEWER: new Set(READ_ONLY),
};

export function isDevRole(value: unknown): value is DevRole {
  return typeof value === "string" && DEV_ROLES.includes(value as DevRole);
}

export function hasDevPermission(role: DevRole, permission: DevPermission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function listDevPermissions(role: DevRole) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
