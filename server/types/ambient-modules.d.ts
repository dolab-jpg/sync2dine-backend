declare module 'qrcode-terminal' {
  const qrcode: {
    generate(value: string, options?: { small?: boolean }): void;
  };
  export default qrcode;
}

declare module 'qrcode' {
  const qrcode: {
    toDataURL(value: string, options?: { width?: number; margin?: number }): Promise<string>;
  };
  export default qrcode;
}

declare module 'mailparser' {
  type Address = { name?: string; address?: string };
  type AddressList = { value?: Address[] };
  export type Attachment = {
    filename?: string;
    contentType?: string;
    size?: number;
    contentId?: string;
    content?: Buffer;
  };
  export function simpleParser(source: Buffer): Promise<{
    from?: AddressList;
    to?: AddressList;
    cc?: AddressList;
    messageId?: string;
    references?: string | string[];
    inReplyTo?: string;
    subject?: string;
    date?: Date;
    text?: string;
    html?: string | Buffer;
    attachments?: Attachment[];
  }>;
}
