import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type SubdomainState = 'active' | 'cold';

@Entity('subdomain')
export class Subdomain {
  @PrimaryColumn({ type: 'uuid' }) id: string;
  @Column({ type: 'text', unique: true }) slug: string;
  @Column({ name: 'owner_id', type: 'uuid', nullable: true }) ownerId: string | null;
  @Column({ name: 'is_custom', type: 'boolean', default: false }) isCustom: boolean;
  @Column({ name: 'token_hash', type: 'text' }) tokenHash: string;
  @Column({ type: 'text', default: 'active' }) state: SubdomainState;
  @Column({ name: 'last_activity_at', type: 'timestamptz', default: () => 'now()' }) lastActivityAt: Date;
  @Column({ name: 'offline_status', type: 'int', default: 200 }) offlineStatus: number;
  @Column({ name: 'offline_body', type: 'text', default: '{"ok":true}' }) offlineBody: string;
  @Column({ name: 'hmac_secret_enc', type: 'text', nullable: true }) hmacSecretEnc: string | null;
  @Column({ name: 'hmac_header', type: 'text', nullable: true }) hmacHeader: string | null;
  @Column({ name: 'hmac_algo', type: 'text', default: 'sha256' }) hmacAlgo: string;
  @Column({ name: 'created_ip_hash', type: 'text', nullable: true }) createdIpHash: string | null;
  @Column({ name: 'always_on_until', type: 'timestamptz', nullable: true }) alwaysOnUntil: Date | null;
  @Column({ name: 'reserved_until', type: 'timestamptz', nullable: true }) reservedUntil: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
