/**
 * Pravshi OS  Mobile Platform Scanner Services.
 *
 * Implements high-level validation for QR codes and document intake,
 * verifying payload schemas, cryptographic challenges, and tenant bounds.
 */

import {
  type BarcodeScanResult,
  type DocumentScanOptions,
  type DocumentScanResult,
  type ICameraProvider,
  type PravshiQrPayload,
  PravshiQrPayloadSchema,
} from './types';

export class BarcodeScannerService {
  constructor(private readonly cameraProvider: ICameraProvider) {}

  /**
   * Prompts user for camera permission and scans for barcodes.
   */
  async scanBarcode(): Promise<BarcodeScanResult | null> {
    const status = await this.cameraProvider.getCameraPermissionStatus();
    if (status !== 'granted') {
      const requested = await this.cameraProvider.requestCameraPermissions();
      if (requested !== 'granted') {
        throw new Error(`Camera permission not granted. Current status: ${requested}`);
      }
    }

    return this.cameraProvider.scanBarcodeOnce();
  }

  /**
   * Parses and validates raw scanned text against Pravshi OS QR contracts.
   * Throws if payload is invalid or unrecognized.
   */
  parsePravshiQr(rawContent: string): PravshiQrPayload {
    try {
      const parsedJson = JSON.parse(rawContent);
      return PravshiQrPayloadSchema.parse(parsedJson);
    } catch (err) {
      throw new Error(
        `Invalid Pravshi QR payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Verifies that a scanned QR belongs to the active tenant.
   * Prevents accidental cross-tenant record leakage or scanning another tenant's asset tag.
   */
  verifyTenantScannedQr(payload: PravshiQrPayload, activeTenantId: string): boolean {
    if ('tenantId' in payload) {
      return payload.tenantId.toLowerCase() === activeTenantId.toLowerCase();
    }
    // SESSION_VERIFICATION is tenant-agnostic pre-login
    return true;
  }
}

export class DocumentScannerService {
  constructor(private readonly cameraProvider: ICameraProvider) {}

  /**
   * Initiates multipage document scan with edge detection and validation.
   */
  async scanDocument(options?: DocumentScanOptions): Promise<DocumentScanResult> {
    const status = await this.cameraProvider.getCameraPermissionStatus();
    if (status !== 'granted') {
      const requested = await this.cameraProvider.requestCameraPermissions();
      if (requested !== 'granted') {
        throw new Error(`Camera permission not granted: ${requested}`);
      }
    }

    const result = await this.cameraProvider.scanDocument({
      maxPages: options?.maxPages ?? 20,
      colorMode: options?.colorMode ?? 'color',
      autoCapture: options?.autoCapture ?? true,
      outputFormat: options?.outputFormat ?? 'images',
      compressionQuality: options?.compressionQuality ?? 0.8,
      ...options,
    });

    if (!result.pages || result.pages.length === 0) {
      throw new Error('Document scan completed with zero pages captured.');
    }

    return result;
  }
}
