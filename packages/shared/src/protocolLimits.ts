/** Native Messagingによるファイル転送の契約値。 */
export const FILE_TRANSFER_LIMITS = {
	maxFiles: 20,
	maxFileBytes: 64 * 1024 * 1024,
	maxTransferBytes: 128 * 1024 * 1024,
	base64ChunkCharacters: 192 * 1024,
} as const;
