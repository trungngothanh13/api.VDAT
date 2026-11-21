import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting VDAT database seeding...');

  // 1. Create Default Users
  const salt = await bcrypt.genSalt(10);
  const adminPassword = await bcrypt.hash('admin123', salt);
  const officerPassword = await bcrypt.hash('police123', salt);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@vdat.local' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000001',
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
      id: '00000000-0000-4000-8000-000000000002',
      email: 'officer@vdat.local',
      fullName: 'Traffic Officer',
      passwordHash: officerPassword,
      role: Role.POLICE,
    },
  });

  console.log(`Users seeded: ${admin.email} (ADMIN), ${officer.email} (POLICE)`);

  // 2. Seed Initial ZoneProfile for test_1.mp4
  const defaultZones = {
    lanes: [
      [
        [429, 161], [433, 247], [550, 230], [560, 213],
        [577, 213], [581, 203], [637, 181], [696, 167],
        [730, 158], [717, 139], [601, 148], [584, 142],
        [434, 156],
      ],
    ],
    intersection: [
      [429, 157], [432, 246], [226, 273], [149, 293],
      [154, 186], [205, 171], [426, 158],
    ],
    exitZones: [],
    traffic_lights: [
      { x: 570, y: 148, color: 'green' },
      { x: 570, y: 130, color: 'red' },
    ],
  };

  const defaultProfile = await prisma.zoneProfile.upsert({
    where: { sourceKey: 'file:test_1.mp4' },
    update: {},
    create: {
      sourceKey: 'file:test_1.mp4',
      name: 'test_1.mp4',
      lanes: defaultZones.lanes,
      intersection: defaultZones.intersection,
      exitZones: defaultZones.exitZones,
      lightBox: defaultZones.traffic_lights,
      crossingMode: false,
      clearanceSeconds: 3.0,
      version: 1,
    },
  });

  // 3. Create 6 Default Camera Slots (cam-01 through cam-06)
  const cameraDefaults = [
    {
      id: 'cam-01',
      name: 'Camera 01 (Primary)',
      location: 'Intersection 1',
      activeSourceKey: 'file:test_1.mp4',
      activeZoneProfileId: defaultProfile.id,
    },
    { id: 'cam-02', name: 'Camera 02', location: 'Intersection 2' },
    { id: 'cam-03', name: 'Camera 03', location: 'Intersection 3' },
    { id: 'cam-04', name: 'Camera 04', location: 'Intersection 4' },
    { id: 'cam-05', name: 'Camera 05', location: 'Intersection 5' },
    { id: 'cam-06', name: 'Camera 06', location: 'Intersection 6' },
  ];

  for (const cam of cameraDefaults) {
    await prisma.camera.upsert({
      where: { id: cam.id },
      update: {},
      create: {
        id: cam.id,
        name: cam.name,
        location: cam.location,
        isActive: false,
        activeSourceKey: cam.activeSourceKey ?? null,
        activeZoneProfileId: cam.activeZoneProfileId ?? null,
        metadata: {
          resolution: '854x480',
          fps: 15,
          model: 'yolo26l.pt',
          tracker: 'bytetrack',
        },
      },
    });
  }

  console.log('Seeded 6 camera slots (cam-01..cam-06) and default ZoneProfile file:test_1.mp4.');
  console.log('Database seeding finished successfully.');
}

main()
  .catch((e) => {
    console.error('Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
