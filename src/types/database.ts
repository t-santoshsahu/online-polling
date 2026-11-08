export type ResidentType = 'owner' | 'resident'
export type UserRole = 'admin' | 'regular'
export type PollType = 'single_choice' | 'ranked_choice'
export type PollRestriction =
  | 'one_per_flat'
  | 'owners_only_one_per_flat'
  | 'residents_only_one_per_flat'
  | 'all_owners'
  | 'all_residents'
  | 'all_owners_and_residents'

export interface UserProfile {
  id: string
  auth_user_id: string
  email: string
  name: string
  contact: string | null
  flat_number: string
  resident_type: ResidentType
  role: UserRole
}

export interface Poll {
  id: string
  title: string
  description: string | null
  poll_type: PollType
  restriction: PollRestriction
  deadline: string
  is_deleted: boolean
  created_by: string
}

export interface PollOption {
  id: string
  poll_id: string
  option_text: string
  image_url: string | null
  display_order: number
}

export interface Vote {
  id: string
  poll_id: string
  flat_number: string
  resident_type: ResidentType
  voted_at: string
}

export interface BallotEntry {
  id: string
  poll_id: string
  option_id: string
  rank_position: number
}