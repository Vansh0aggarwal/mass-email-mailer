import { AssessmentRating } from '../models/Company.js';

export interface ScoringConfig {
  explicit_need_weight: number;
  assessment_rating_weight: number;
  freshness_weight: number;
  min_qualification_threshold: number;
  rating_score_map: Record<string, number | null>;
}

export const defaultScoringConfig: ScoringConfig = {
  explicit_need_weight: 60,
  assessment_rating_weight: 25,
  freshness_weight: 15,
  min_qualification_threshold: 35,
  rating_score_map: {
    A: 100,
    B: 75,
    C: 50,
    D: 25,
    F: 10,
    unrated: null,
  },
};

export interface CompanyEvaluationInput {
  company: {
    id: string;
    name: string;
    domain?: string | null;
    industry?: string | null;
    overallRating: AssessmentRating;
    services: string[];
    notes?: string | null;
  };
  assessments?: {
    normalizedRating: AssessmentRating;
    rawScore?: number | null;
    source?: string | null;
    assessmentDate: Date;
  }[];
  availableCatalogServices: {
    id: string;
    name: string;
    code: string;
    description: string;
    valueProposition: string;
    triggerKeywords: string[];
    isActive: boolean;
  }[];
}

export interface RecommendationEvaluationResult {
  score: number;
  confidence: number;
  recommendedServices: {
    serviceId: string;
    serviceName: string;
    reason: string;
  }[];
  ruleExplanations: string[];
  evidence: {
    type: 'explicit_need' | 'assessment' | 'keyword_match';
    reference: string;
    detail: string;
  }[];
  missingDataWarnings: string[];
  pitchSummary: string;
  isQualified: boolean;
}

/**
 * Transparent Opportunity Recommendation Engine
 * - Prioritizes explicit company requirements (PRIMARY evidence).
 * - Ratings and observations serve as SUPPORTING evidence.
 * - Missing ratings or absence of websites are NEVER treated as zero or proof of a flaw.
 * - Generates coherent multi-service pitch summary.
 */
export function evaluateOpportunity(
  input: CompanyEvaluationInput,
  config: ScoringConfig = defaultScoringConfig
): RecommendationEvaluationResult {
  const { company, assessments = [], availableCatalogServices } = input;

  const ruleExplanations: string[] = [];
  const evidence: RecommendationEvaluationResult['evidence'] = [];
  const missingDataWarnings: string[] = [];
  const recommendedServices: RecommendationEvaluationResult['recommendedServices'] = [];

  let totalScore = 0;
  let confidencePoints = 0;
  const maxPossibleConfidence = 100;

  // 1. EVALUATE EXPLICIT SERVICE NEEDS (Primary Weight: 60%)
  if (company.services && company.services.length > 0) {
    confidencePoints += 50;

    for (const needText of company.services) {
      const cleanNeed = needText.toLowerCase();

      // Find matching catalog service
      const matchedCatalog = availableCatalogServices.find((svc) => {
        if (!svc.isActive) return false;
        if (svc.name.toLowerCase().includes(cleanNeed) || cleanNeed.includes(svc.name.toLowerCase())) return true;
        return svc.triggerKeywords.some((kw) => cleanNeed.includes(kw.toLowerCase()));
      });

      if (matchedCatalog) {
        recommendedServices.push({
          serviceId: matchedCatalog.id,
          serviceName: matchedCatalog.name,
          reason: `Company explicitly listed requirement matching '${matchedCatalog.name}'`,
        });
        evidence.push({
          type: 'explicit_need',
          reference: matchedCatalog.name,
          detail: `Prospect explicitly declared need: "${needText}"`,
        });
        ruleExplanations.push(`Explicit requirement "${needText}" matches catalog service "${matchedCatalog.name}".`);
      } else {
        ruleExplanations.push(`Declared need "${needText}" noted as custom requirement.`);
      }
    }

    totalScore += config.explicit_need_weight;
  } else {
    missingDataWarnings.push('No explicit requirements specified in imported record.');
  }

  // 2. EVALUATE ASSESSMENTS & RATINGS (Supporting Weight: 25%)
  if (company.overallRating && company.overallRating !== 'unrated') {
    confidencePoints += 30;

    // A low rating (C, D, F) indicates high need for remediation/redesign
    if (['C', 'D', 'F'].includes(company.overallRating)) {
      totalScore += config.assessment_rating_weight;
      ruleExplanations.push(
        `Digital health assessment rating is '${company.overallRating}', indicating strong improvement potential.`
      );
      evidence.push({
        type: 'assessment',
        reference: `Rating ${company.overallRating}`,
        detail: `Verified website/social evaluation grade '${company.overallRating}' suggests opportunity for modernization.`,
      });

      // Suggest Website Redesign or Speed if not already included
      const redesignSvc = availableCatalogServices.find((s) => s.code === 'web-redesign' || s.code === 'website-redesign');
      if (redesignSvc && !recommendedServices.some((r) => r.serviceId === redesignSvc.id)) {
        recommendedServices.push({
          serviceId: redesignSvc.id,
          serviceName: redesignSvc.name,
          reason: `Digital assessment score (${company.overallRating}) indicates modernization need`,
        });
      }
    } else {
      // Good rating (A or B) indicates growth/optimization or partnership opportunity
      totalScore += Math.round(config.assessment_rating_weight * 0.6);
      ruleExplanations.push(
        `Digital health assessment rating is favorable ('${company.overallRating}'). Recommended focus: growth and expansion.`
      );
      evidence.push({
        type: 'assessment',
        reference: `Rating ${company.overallRating}`,
        detail: `Solid digital foundation ('${company.overallRating}') provides base for advanced optimization.`,
      });
    }
  } else {
    // Crucial rule: Never penalize missing ratings as broken or 0
    missingDataWarnings.push('Digital assessment rating unrecorded (not assumed zero or flawed).');
  }

  // 3. INDUSTRY & METADATA FRESHNESS (Supporting Weight: 15%)
  if (company.industry) {
    confidencePoints += 20;
    totalScore += config.freshness_weight;
  } else {
    missingDataWarnings.push('Target industry category is not specified.');
  }

  // Normalize confidence (0 to 1)
  const confidence = Math.min(1.0, Math.round((confidencePoints / maxPossibleConfidence) * 100) / 100);
  const finalScore = Math.min(100, Math.round(totalScore));
  const isQualified = finalScore >= config.min_qualification_threshold && recommendedServices.length > 0;

  // Generate Coherent Combined Pitch Summary
  let pitchSummary = '';
  if (recommendedServices.length === 1) {
    pitchSummary = `Position ${recommendedServices[0].serviceName} directly addressing their confirmed requirements.`;
  } else if (recommendedServices.length > 1) {
    const names = recommendedServices.map((s) => s.serviceName).join(' and ');
    pitchSummary = `Propose an integrated growth roadmap combining ${names} for maximum compounding ROI.`;
  } else {
    pitchSummary = `General consultative introduction to discover ${company.name}'s current growth priorities.`;
  }

  return {
    score: finalScore,
    confidence,
    recommendedServices,
    ruleExplanations,
    evidence,
    missingDataWarnings,
    pitchSummary,
    isQualified,
  };
}
