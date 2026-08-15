export type {
  AdminUserRowDto,
  AttributeProvenance,
  AuditEventDto,
  ChatAttachment,
  ChatMessageDto,
  ChatTurnDto,
  ConnectionSummaryDto,
  DogProfileDto,
  HealthDto,
  JobRowDto,
  MatchCandidateDto,
  MatchRequestDto,
  MediaAssetDto,
  MediaImportSummaryDto,
  MeetupDto,
  MessageDto,
  PendingConfirmationDto,
  PreferencesDto,
  ReportDto,
  SearchResultDto,
  SocialProviderDescriptorDto,
  ViewerDto,
} from '@doggystyle/shared';

export interface AppConfig {
  brand: { name: string; tagline: string };
  demoMode: boolean;
  aiProvider: string;
  minimumAgeYears: number;
  knownCities?: { city: string; country: string }[];
}

export interface ChatThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface AdminEmailRow {
  id: string;
  toAddress: string;
  subject: string;
  link: string | null;
  transport: string;
  createdAt: string;
}
