export interface CreateServiceGroupProps {
  name: string;
  slug: string;
  displayOrder?: number;
}

export interface UpdateServiceGroupProps {
  name?: string;
  slug?: string;
  displayOrder?: number;
}

export interface ServiceGroupEntity {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
