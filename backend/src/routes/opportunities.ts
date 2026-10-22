import { Router, Request, Response, NextFunction } from 'express';
import { Company } from '../models/Company.js';
import { Service } from '../models/Service.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { evaluateOpportunity } from '../services/opportunity-scoring.service.js';

const router = Router();

// GET /api/v1/opportunities
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const { companyId } = req.query;

    const companyQuery: any = { organizationId: orgId, isArchived: false };
    if (companyId) {
      companyQuery._id = companyId;
    }

    const [companies, catalogServices, assessments] = await Promise.all([
      Company.find(companyQuery).lean(),
      Service.find({ organizationId: orgId, isActive: true }).lean(),
      CompanyAssessment.find({ organizationId: orgId }).lean(),
    ]);

    const assessmentMap = new Map<string, any[]>();
    for (const a of assessments) {
      const key = a.companyId.toString();
      if (!assessmentMap.has(key)) assessmentMap.set(key, []);
      assessmentMap.get(key)!.push(a);
    }

    const formattedCatalog = catalogServices.map((s) => ({
      id: s._id.toString(),
      name: s.name,
      code: s.code,
      description: s.description,
      valueProposition: s.valueProposition,
      triggerKeywords: s.triggerKeywords,
      isActive: s.isActive,
    }));

    const opportunities = companies.map((comp) => {
      const compAssessments = assessmentMap.get(comp._id.toString()) || [];
      const result = evaluateOpportunity({
        company: {
          id: comp._id.toString(),
          name: comp.name,
          domain: comp.domain,
          industry: comp.industry,
          overallRating: comp.overallRating,
          services: comp.services || [],
          notes: comp.notes,
        },
        assessments: compAssessments.map((ca) => ({
          normalizedRating: ca.normalizedRating,
          rawScore: ca.rawScore,
          source: ca.source,
          assessmentDate: ca.assessmentDate,
        })),
        availableCatalogServices: formattedCatalog,
      });

      return {
        companyId: comp._id.toString(),
        companyName: comp.name,
        ...result,
      };
    });

    // Sort by highest opportunity score first
    opportunities.sort((a, b) => b.score - a.score);

    res.status(200).json({
      success: true,
      data: opportunities,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
