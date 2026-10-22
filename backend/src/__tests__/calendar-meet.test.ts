import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { CalendarAccount } from '../models/CalendarAccount.js';

describe('Google Calendar & Google Meet Integration', () => {
  let app: any;
  const tenant = 'org_calendar_test_tenant';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  afterAll(async () => {
    await CalendarAccount.deleteMany({ organizationId: tenant });
    await disconnectDatabase();
  });

  describe('Natural Language Meeting Parser & Ambiguity Clarification', () => {
    it('detects missing date, time, and attendee information as ambiguous', async () => {
      const res = await request(app)
        .post('/api/v1/calendar/parse-meeting')
        .set('x-organization-id', tenant)
        .send({
          text: 'Can we schedule a quick call sometime next week?',
          timezone: 'Asia/Kolkata',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isAmbiguous).toBe(true);
      expect(res.body.data.clarificationQuestions.length).toBeGreaterThan(0);
      expect(
        res.body.data.clarificationQuestions.some((q: string) => q.toLowerCase().includes('time'))
      ).toBe(true);
      expect(
        res.body.data.clarificationQuestions.some((q: string) => q.toLowerCase().includes('attendee'))
      ).toBe(true);
    });

    it('parses complete natural language scheduling prompt without ambiguity', async () => {
      const res = await request(app)
        .post('/api/v1/calendar/parse-meeting')
        .set('x-organization-id', tenant)
        .send({
          text: 'Schedule a 45 min demo call tomorrow at 3:30 PM with founder@acmecorp.com regarding site audit',
          timezone: 'Asia/Kolkata',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isAmbiguous).toBe(false);
      expect(res.body.data.clarificationQuestions).toHaveLength(0);
      expect(res.body.data.parsedDetails.durationMinutes).toBe(45);
      expect(res.body.data.parsedDetails.attendees).toContain('founder@acmecorp.com');
      expect(res.body.data.parsedDetails.addMeetLink).toBe(true);
    });
  });

  describe('Event Creation & Google Meet Link Generation', () => {
    it('POST /api/v1/calendar/events generates meeting with verified Google Meet link in dev/mock environment', async () => {
      const startTime = new Date(Date.now() + 86400000).toISOString();
      const endTime = new Date(Date.now() + 86400000 + 1800000).toISOString();

      const res = await request(app)
        .post('/api/v1/calendar/events')
        .set('x-organization-id', tenant)
        .send({
          summary: 'Website Redesign Discovery Call',
          startTime,
          endTime,
          timezone: 'Asia/Kolkata',
          attendees: ['client@company.in'],
          addMeetLink: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.eventId).toBeDefined();
      expect(res.body.data.meetLink).toBeDefined();
      expect(res.body.data.meetLink).toMatch(/^https:\/\/meet\.google\.com\/[a-z0-9\-]+$/i);
      expect(res.body.data.attendees).toContain('client@company.in');
    });

    it('GET /api/v1/calendar/accounts returns empty list for new tenant and handles disconnects', async () => {
      const res = await request(app)
        .get('/api/v1/calendar/accounts')
        .set('x-organization-id', tenant);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      // Create a mock account to test disconnect
      const account = await CalendarAccount.create({
        organizationId: tenant,
        userId: 'usr_test',
        displayName: 'Test Executive',
        emailAddress: 'exec@swaniki.com',
        provider: 'mock',
        status: 'connected',
      });

      const listRes = await request(app)
        .get('/api/v1/calendar/accounts')
        .set('x-organization-id', tenant);

      expect(listRes.body.data.length).toBe(1);
      expect(listRes.body.data[0].emailAddress).toBe('exec@swaniki.com');

      const delRes = await request(app)
        .delete(`/api/v1/calendar/accounts/${account._id}`)
        .set('x-organization-id', tenant);

      expect(delRes.status).toBe(200);
      expect(delRes.body.data.disconnected).toBe(true);
    });
  });
});
