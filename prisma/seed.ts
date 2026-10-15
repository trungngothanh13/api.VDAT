import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting VDAT database seeding...');

  // 1. Create Default Users
  const salt = await bcrypt.genSalt(10);
  const adminPassword = await bcrypt.hash('admin123', salt);
  const officerPassword = await bcrypt.hash('police123', salt);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@vdat.local' },
    update: {},
    create: {
      email: 'admin@vdat.local',
      fullName: 'System Administrator',
      passwordHash: adminPassword,
      role: Role.ADMIN,
    },
  });

  const officer = await prisma.user.upsert({
    where: { email: 'officer@vdat.local' },
    update: {},
    create: {
      email: 'officer@vdat.local',
      fullName: 'Traffic Officer',
      passwordHash: officerPassword,
      role: Role.POLICE,
    },
  });

  console.log(`👤 Users seeded: ${admin.email} (ADMIN), ${officer.email} (POLICE)`);

  // 2. Create Default Camera (cam-01) with Initial Zones
  const defaultZones = {
    lanes: [
      [
        [429, 161], [433, 247], [550, 230], [560, 213],
        [577, 213], [581, 203], [637, 181], [696, 167],
        [730, 158], [717, 139], [601, 148], [584, 142],
        [434, 156]
      ]
    ],
    intersection: [
      [429, 157], [432, 246], [226, 273], [149, 293],
      [154, 186], [205, 171], [426, 158]
    ],
    traffic_lights: [
      { x: 570, y: 148, color: 'green' },
      { x: 570, y: 130, color: 'red' }
    ]
  };

  const camera = await prisma.camera.upsert({
    where: { id: 'cam-01' },
    update: {},
    create: {
      id: 'cam-01',
      name: 'Nguyen Trai - Khuat Duy Tien Intersection',
      location: 'Thanh Xuan, Hanoi',
      rtspUrl: 'rtsp://localhost:8554/live/cam1',
      isActive: true,
      metadata: {
        resolution: '854x480',
        fps: 30,
        model: 'yolo26l.pt',
        tracker: 'bytetrack',
      },
    },
  });

  await prisma.cameraConfig.upsert({
    where: { cameraId: 'cam-01' },
    update: {},
    create: {
      cameraId: 'cam-01',
      lanes: defaultZones.lanes,
      intersection: defaultZones.intersection,
      lightBox: defaultZones.traffic_lights,
      version: 1,
    },
  });

  console.log(`📹 Camera seeded: ${camera.id} (${camera.name}) with default zone geometry.`);
  console.log('✅ Database seeding finished successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
