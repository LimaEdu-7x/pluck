import type { ExtractionModule } from './types';
import { pageZipModule } from './page-zip';
import { imagesZipModule } from './images-zip';
import { pageHtmlModule } from './page-html';

export const availableModules: ExtractionModule[] = [
  pageHtmlModule,
  pageZipModule,
  imagesZipModule
];

export function getModuleById(id: string): ExtractionModule | undefined {
  return availableModules.find((m) => m.id === id);
}

export * from './types';
export { pageZipModule } from './page-zip';
export { imagesZipModule } from './images-zip';
export { pageHtmlModule } from './page-html';
