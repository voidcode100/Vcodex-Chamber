declare module "qrcode" {
  type QrOptions = {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    color?: { dark?: string; light?: string };
  };

  const QRCode: {
    toDataURL(text: string, options?: QrOptions): Promise<string>;
  };

  export default QRCode;
}
