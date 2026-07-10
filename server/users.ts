import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

export type UserRole =
  | 'platform_owner'
  | 'super_admin'
  | 'manager'
  | 'staff'
  | 'builder'
  | 'recruitment'
  | 'customer';

export interface PlatformUser {
  id: string;
  orgId: string | null;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

let memoryUsers: PlatformUser[] = [];

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk(): PlatformUser[] {
  try {
    if (existsSync(USERS_FILE)) {
      const parsed = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
      return Array.isArray(parsed) ? parsed as PlatformUser[] : [];
    }
  } catch {
    // ignore
  }
  return [];
}

function persist() {
  ensureDir();
  try {
    writeFileSync(USERS_FILE, JSON.stringify(memoryUsers, null, 2));
  } catch {
    // ignore
  }
}

function seedDefaultUsers() {
  const email = process.env.PLATFORM_OWNER_EMAIL?.trim() || 'owner@tradepro.com';
  const password = process.env.PLATFORM_OWNER_PASSWORD?.trim() || 'platform123';
  const hash = bcrypt.hashSync(password, 10);
  memoryUsers = [{
    id: 'user_platform_owner',
    orgId: null,
    name: 'Platform Owner',
    email,
    passwordHash: hash,
    role: 'platform_owner',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }];
  persist();
}

export function listUsers(): PlatformUser[] {
  if (memoryUsers.length === 0) {
    memoryUsers = loadFromDisk();
    if (memoryUsers.length === 0) seedDefaultUsers();
  }
  return [...memoryUsers];
}

export function getUserByEmail(email: string): PlatformUser | undefined {
  const normalized = email.trim().toLowerCase();
  return listUsers().find(u => u.email.toLowerCase() === normalized);
}

export function getUserById(id: string): PlatformUser | undefined {
  return listUsers().find(u => u.id === id);
}

export function verifyPassword(user: PlatformUser, password: string): boolean {
  return bcrypt.compareSync(password, user.passwordHash);
}

export interface CreateUserInput {
  orgId: string | null;
  name: string;
  email: string;
  password: string;
  role: UserRole;
}

export function createUser(input: CreateUserInput): PlatformUser {
  const now = new Date().toISOString();
  const user: PlatformUser = {
    id: `user_${Date.now().toString(36)}`,
    orgId: input.orgId,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    passwordHash: bcrypt.hashSync(input.password, 10),
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
  memoryUsers = [user, ...listUsers()];
  persist();
  return user;
}

export function sanitizeUser(user: PlatformUser) {
  const { passwordHash: _p, ...rest } = user;
  return rest;
}
