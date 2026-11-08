import { EditError } from './metadata.ts';

/** Identifies the inputs to correct without logging the submitted form. */
export class ManualInputError extends EditError {
  fields: string[];
  constructor(message: string, ...fields: string[]) {
    super(message);
    this.fields = fields;
  }
}

/** Normalize full-width numbers and punctuation commonly copied from the platform. */
export const manualText = (value: unknown) =>
  String(value ?? '')
    .normalize('NFKC')
    .trim();
export const missingManualValue = (text: string) => !text || /^(?:—|–|-|N\/A)$/i.test(text);
