# Deployment Guide

This document explains how to deploy the Elite SACCO Mbarara application in a typical production or staging environment. It assumes a Node.js + MySQL stack, with the frontend and backend run separately or behind a hosted web server.

## 1. Deployment Overview

The project contains:

- a front-end web app in the repo root
- a backend server in `server/`
- a MySQL database defined in `database/schema.sql`
- environment configuration files for app and database settings

The deployment flow is generally:

1. Provision Linux server or hosting environment
2. Install dependencies
3. Configure environment variables
4. Import database schema and seed data
5. Build or prepare frontend assets
6. Start the backend service
7. Serve the frontend or static build
8. Validate login, member data, and reporting

---

## 2. Requirements

### Server requirements

- Ubuntu 22.04+ or similar Linux distribution
- Node.js 18.x
- NPM 9.x+
- MySQL 8.0+
- Git
- Nginx or another reverse proxy (recommended)
- PM2 or systemd for service management (recommended)
- SFTP/SSH access for deployment

### Recommended operating system setup

```bash
sudo apt update
sudo apt install -y curl git nginx mysql-server build-essential
