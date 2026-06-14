import { Component, OnInit, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InvestmentService } from '../../services/investment.service';
import { AuthService } from '../../services/auth.service';

interface AllowlistUser {
  email: string;
  added_date: string;
  role: 'admin' | 'user' | 'guest';
}

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-management.component.html',
  styleUrl: './user-management.component.scss'
})
export class UserManagementComponent implements OnInit {
  users: AllowlistUser[] = [];
  loading = false;
  error = '';
  successMsg = '';

  // Add user form
  showAddForm = false;
  newEmail = '';
  newRole: 'admin' | 'user' | 'guest' = 'user';
  adding = false;

  // Inline role editing
  editingRoleFor: string | null = null;
  editingRole: 'admin' | 'user' | 'guest' = 'user';
  savingRole = false;

  removingEmail: string | null = null;
  viewingAsEmail: string | null = null;

  @Output() viewAs = new EventEmitter<string>();

  constructor(private investmentService: InvestmentService, private authService: AuthService) {}

  ngOnInit(): void {
    this.loadUsers();
  }

  loadUsers(): void {
    this.loading = true;
    this.error = '';
    this.investmentService.getAllowlist().subscribe({
      next: (res) => {
        this.users = res.allowlist;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.error || 'Failed to load users.';
        this.loading = false;
      }
    });
  }

  addUser(): void {
    if (!this.newEmail.trim()) return;
    this.adding = true;
    this.error = '';
    this.successMsg = '';
    this.investmentService.addToAllowlist(this.newEmail.trim(), this.newRole).subscribe({
      next: () => {
        this.successMsg = `Added ${this.newEmail.trim()} as ${this.newRole}.`;
        this.newEmail = '';
        this.newRole = 'user';
        this.showAddForm = false;
        this.adding = false;
        this.loadUsers();
      },
      error: (err) => {
        this.error = err?.error?.error || 'Failed to add user.';
        this.adding = false;
      }
    });
  }

  startEditRole(user: AllowlistUser): void {
    this.editingRoleFor = user.email;
    this.editingRole = user.role;
    this.error = '';
    this.successMsg = '';
  }

  cancelEditRole(): void {
    this.editingRoleFor = null;
  }

  saveRole(): void {
    if (!this.editingRoleFor) return;
    this.savingRole = true;
    this.error = '';
    this.successMsg = '';
    this.investmentService.updateUserRole(this.editingRoleFor, this.editingRole).subscribe({
      next: () => {
        this.successMsg = `Role updated for ${this.editingRoleFor}.`;
        this.editingRoleFor = null;
        this.savingRole = false;
        this.loadUsers();
      },
      error: (err) => {
        this.error = err?.error?.error || 'Failed to update role.';
        this.savingRole = false;
      }
    });
  }

  removeUser(email: string): void {
    if (!confirm(`Remove ${email} from the allowlist? They will lose access immediately.`)) return;
    this.removingEmail = email;
    this.error = '';
    this.successMsg = '';
    this.investmentService.removeFromAllowlist(email).subscribe({
      next: () => {
        this.successMsg = `Removed ${email}.`;
        this.removingEmail = null;
        this.loadUsers();
      },
      error: (err) => {
        this.error = err?.error?.error || 'Failed to remove user.';
        this.removingEmail = null;
      }
    });
  }

  roleLabel(role: string): string {
    return { admin: '👑 Admin', user: '✏️ User', guest: '👁️ Guest' }[role] ?? role;
  }

  roleBadgeClass(role: string): string {
    return { admin: 'badge-admin', user: 'badge-user', guest: 'badge-guest' }[role] ?? '';
  }

  clearMessages(): void {
    this.error = '';
    this.successMsg = '';
  }

  viewAsUser(email: string, role: 'admin' | 'user' | 'guest'): void {
    this.authService.startImpersonation(email, role);
    this.viewAs.emit(email);
  }
}
