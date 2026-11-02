/**
 * Pravshi OS  Mobile Platform Camera & Document Scanner Types.
 *
 * Provides strictly typed interfaces for hardware camera access,
 * QR / barcode detection, and multipage document edge detection.
 */

import { z } from 'zod';

export type CameraPermissionStatus = 'granted' | 'denied' | 'restricted' | 'undetermined';

export type BarcodeFormat =
  'qr' | 'code128' | 'code39' | 'ean13' | 'ean8' | 'upc_a' | 'upc_e' | 'data_matrix' | 'pdf417';

export interface BarcodeBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarcodeScanResult {
  rawValue: string;
  format: BarcodeFormat;
  bounds?: BarcodeBoundingBox;
  timestamp: number;
}

export interface DocumentCornerPoints {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
}

export interface DocumentScanOptions {
  maxPages?: number;
  colorMode?: 'color' | 'grayscale' | 'monochrome';
  autoCapture?: boolean;
  edgeDetectionThreshold?: number;
  outputFormat?: 'pdf' | 'images';
  compressionQuality?: number; // 0.0 - 1.0
}

export interface ScannedDocumentPage {
  pageNumber: number;
  uri: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  corners?: DocumentCornerPoints;
  ocrExtractedText?: string;
}

export interface DocumentScanResult {
  pages: ScannedDocumentPage[];
  totalPages: number;
  scanTimestamp: number;
  pdfUri?: string;
  pdfByteSize?: number;
}

export interface ICameraProvider {
  requestCameraPermissions(): Promise<CameraPermissionStatus>;
  getCameraPermissionStatus(): Promise<CameraPermissionStatus>;
  scanBarcodeOnce(acceptedFormats?: BarcodeFormat[]): Promise<BarcodeScanResult | null>;
  scanDocument(options?: DocumentScanOptions): Promise<DocumentScanResult>;
}

export const PravshiQrPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('TENANT_INVITE'),
    tenantId: z.string().uuid(),
    inviteCode: z.string().min(6),
    organizationName: z.string().min(1),
  }),
  z.object({
    type: z.literal('SESSION_VERIFICATION'),
    sessionId: z.string().uuid(),
    challenge: z.string().min(16),
    expiresAt: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('ASSET_TAG'),
    tenantId: z.string().uuid(),
    assetId: z.string().min(1),
    category: z.string(),
  }),
  z.object({
    type: z.literal('DEAL_OR_PROJECT'),
    tenantId: z.string().uuid(),
    entityType: z.enum(['lead', 'deal', 'project', 'task']),
    entityId: z.string().uuid(),
  }),
]);

export type PravshiQrPayload = z.infer<typeof PravshiQrPayloadSchema>;
